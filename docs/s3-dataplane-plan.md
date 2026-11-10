# Plan: S3 data plane

Status: planned. There is no S3 service yet.

## Goal

Emulate the S3 **data plane** (objects: put, get, head, list, delete, copy, multipart) on top of the local file system, because other services use it under the hood: CloudFormation reads templates from `TemplateURL` and CDK/SAM upload assets, Lambda deployment packages come from buckets, and policies that matter for the network simulation (data perimeter, "bucket reachable only through a VPC endpoint") are evaluated on S3 requests. The control plane (buckets, their policies and configuration) is part of the same service and is a prerequisite.

It is an emulation for prediction, not a storage product: correctness of the API behaviour and of the request context matters; performance does not.

## Storage layout

Each bucket is a directory; each object is a file with the contents; the metadata of an object is kept in a separate JSON file. Proposed layout, next to the rest of `db/` and through `src/app/api/db/store.ts` (the only code that knows the layout):

```
db/s3/<bucket>/bucket.json            owner account, region, creation date, configuration (policy, ACL, versioning,
                                      encryption, tags, CORS, lifecycle, public access block, notifications, ...)
db/s3/<bucket>/objects/<object>/<versionId>.data   content of one version, byte for byte (absent for a delete marker)
db/s3/<bucket>/objects/<object>/<versionId>.json   metadata of that version: ETag, size, content type and other system
                                                   metadata, user metadata (x-amz-meta-*), tags, storage class, checksums,
                                                   encryption (SSE-S3 / SSE-KMS key), last modified, ACL, isDeleteMarker
db/s3/<bucket>/objects/<object>/index.json         the versions of the key, newest first (the order ListObjectVersions uses)
```

`<object>` is the encoded key (see below). Versioning is part of the layout from the start: a bucket that has never been versioned has one version per key with the ID `null`, so there is one code path.

Bucket names are unique in the whole partition, not per account, so the bucket directories live at the top of `db/s3/` and `bucket.json` records the owner account and region. (Open question: the existing layout is `db/<account>/<region>/<service>.json` for state and `db/<account>/<region>/data/<service>/...` for data (log events, invocation records; see `store.ts`); S3 deliberately does not follow the per-account path for the reason above. When S3 is built, `bucket.json` is state and the objects and their metadata are data, so the same rule applies: they should live in a `data` directory of their own, not mixed with the state files.)

Contents are real files, never embedded in JSON; metadata is small JSON. Writes follow the store's rule: write a temp file and rename into place, content first, then metadata.

### The key to file name problem

S3 has a flat key space: `a` and `a/b` can both exist, keys may be up to 1024 bytes, contain `..`, empty segments (`a//b`), trailing `/`, any Unicode, and differ only in case. A file system cannot represent that directly (a path is either a file or a directory, 255 bytes per component, case folding on macOS). So the object name on disk cannot be the key as a path. Proposed: a reversible encoding of the whole key into **one** path component (percent-encoding of every character outside a safe set, including `/`), with a hash-based name plus the real key in the metadata for keys that would be too long. The metadata file always holds the exact key, so listing never depends on decoding file names. Prefix and delimiter listing (`ListObjectsV2`, `CommonPrefixes`) is computed from the keys in sorted order, as S3 does (UTF-8 binary order). Browsing the directory by hand gets slightly less pleasant; correctness wins. Decide before writing code.

### Versioning

Versioning is part of the storage design from the start, because it changes what a "put" and a "delete" do and what is on disk (layout above). A bucket is *unversioned* (the initial state), *enabled* or *suspended* (once enabled it can never go back to unversioned). The unit on disk is a **version**; an unversioned bucket has a single version per key whose ID is `null`.

Behaviour to implement, each with the real error and header:
- **Enabled bucket**: `PutObject` adds a new version with a new opaque `versionId` and returns it in `x-amz-version-id`; `GetObject` and `HeadObject` return the latest, or a given `versionId`; a delete **without** a version ID adds a *delete marker* (a version without data; `GetObject` then answers `NoSuchKey` with `x-amz-delete-marker: true`); a delete **with** a version ID removes that version for good and needs the separate permission `s3:DeleteObjectVersion`; deleting the delete marker brings the previous version back.
- **Suspended bucket**: new objects get version `null` and overwrite the existing `null` version; versions that already exist stay.
- **Enabling on a bucket that has objects**: the existing objects become version `null`.
- `ListObjectVersions` (keys and versions, delete markers, `KeyMarker` / `VersionIdMarker` paging), `ListObjectsV2` shows only the latest non-delete-marker versions, `CopyObject` with a source `versionId`, `GetObjectAttributes`, tagging per version, and `DeleteBucket` fails while any version or delete marker exists (`BucketNotEmpty`).
- Dependencies of versioning, listed so they are not forgotten: lifecycle rules for noncurrent versions and expired delete markers, replication, Object Lock and retention (which need versioning), MFA delete (not modelled), and CloudFormation `DeletionPolicy` / bucket deletion behaviour.
- Quotas: versions are objects for every limit that counts objects.

### Events to other services

S3 can notify other services about what happens in a bucket, and that is how buckets start Lambda functions, so it belongs in the plan from the start even though the first version only records it.
- **Configuration**: `PutBucketNotificationConfiguration` with Lambda, SQS and SNS destinations and EventBridge (`EventBridgeConfiguration`), event types (`s3:ObjectCreated:*` and its specific forms `Put`, `Post`, `Copy`, `CompleteMultipartUpload`; `s3:ObjectRemoved:Delete` and `DeleteMarkerCreated`; `s3:ObjectRestore:*`, `s3:LifecycleExpiration:*`, `s3:Replication:*`, `s3:ObjectTagging:*`) and key filters (`prefix`, `suffix`). The configuration is validated when it is put, as AWS does: the destination must exist and S3 must be allowed to use it (for Lambda a resource policy statement for `s3.amazonaws.com` with `aws:SourceArn` of the bucket and `aws:SourceAccount`; for SQS and SNS the queue or topic policy), otherwise `InvalidArgument` with the reason. (From memory of AWS behaviour, to verify; the S3 `s3:TestEvent` message sent to SQS and SNS on configuration is part of it.)
- **The event**: the real JSON shape (`Records[]` with `eventSource`, `eventName`, `eventTime`, `s3.bucket`, `s3.object.key` (URL-encoded), `size`, `eTag`, `versionId`, `sequencer`, `requestParameters.sourceIPAddress`, `userIdentity`, `responseElements.x-amz-request-id`), produced by the data plane operation that caused it and queued for delivery **after** the request has completed (delivery is asynchronous and at-least-once in AWS; here in order, with the option to hold, delay or duplicate events in a scenario).
- **Delivery** is a *service acting for you*: S3 invokes the function (`lambda:InvokeFunction`, asynchronous invocation) as the service principal `s3.amazonaws.com` with `aws:SourceArn` / `aws:SourceAccount`, so the Lambda resource policy is checked with those keys; the function runs in its own execution context ([lambda-plan.md](./lambda-plan.md): its role and its network position, not the uploader's) and the invocation result and any failure go to the event log, and later to retries and destinations as Lambda defines them. SQS and SNS destinations deliver to the emulated services when they exist; until then the event is recorded in an **event log** per bucket (`db/s3/<bucket>/events.json`) that scenarios and the consoles can read.
- The event log and the trace give the explanation for "why did my function not run": no matching configuration, the filter did not match, the permission was missing, the function failed.
- Other producers use the same mechanism: the event bus of the account (EventBridge) is the natural common destination for service events.

## Behaviour to cover

- **Buckets**: `CreateBucket` (name rules, `BucketAlreadyExists` / `BucketAlreadyOwnedByYou`, location constraint, region), `DeleteBucket` (`BucketNotEmpty`), `HeadBucket`, `ListBuckets`, `GetBucketLocation`, and the configuration operations (policy, versioning, encryption, tagging, public access block, ACL/ownership, CORS, lifecycle, notification) as they are needed.
- **Objects**: `PutObject`, `GetObject` (ranges, conditional headers `If-Match` / `If-None-Match` / `If-Modified-Since`, `Content-Type` and system metadata round trip), `HeadObject`, `DeleteObject`, `DeleteObjects`, `CopyObject` (with metadata directive), `ListObjectsV2` and `ListObjects`, `GetObjectTagging` / `PutObjectTagging`, `GetObjectAttributes`.
- **Multipart upload**: create, upload part, list parts, complete (ETag `<md5 of md5s>-<n>`, 5 MiB minimum part size except the last), abort, and the unfinished parts kept in a staging directory.
- **Versioning and events**: see the two sections above (versions on disk, delete markers, `ListObjectVersions`, suspended buckets; notifications to Lambda, SQS, SNS and EventBridge). Object Lock, replication, inventory, Select and lifecycle execution are later.
- **ETag, checksums** (MD5, `x-amz-checksum-*`), `Content-MD5` validation, `Expect: 100-continue`, chunked/streaming SigV4 payloads (`aws-chunked`) as the SDKs send them.
- **Encryption metadata**: SSE-S3 and SSE-KMS are recorded and returned (`x-amz-server-side-encryption`, key ID) and the KMS key must exist and be usable by the caller once KMS is emulated; the bytes on disk stay plain.
- **Errors** are the real S3 XML errors (`NoSuchBucket`, `NoSuchKey`, `AccessDenied`, `PreconditionFailed`, `EntityTooLarge`, ...), with the request ID and host ID fields.

## Protocol and routing

S3 is REST with XML, and the bucket is addressed two ways: path-style (`/bucket/key`) and virtual-hosted style (`bucket.s3.<region>.amazonaws.com`, key in the path). `src/proxy.ts` rewrites by credential scope service into `/api/<service>...`, so S3 needs the bucket from the path or from the `Host` header, which in turn means the network shim must resolve `bucket.s3.<region>.amazonaws.com` to the emulated S3 endpoint and keep the host header. Pre-signed URLs (SigV4 in the query string, `X-Amz-Signature`, expiry) and anonymous requests (public buckets) need support in the proxy's verification, which today expects an `Authorization` header. The service adapter is a new REST XML protocol next to `RestJsonProtocol`.

## Authorization and request context

The S3 data plane is where several context keys matter: bucket policy, ACLs, Block Public Access, `aws:SourceVpce` / `aws:SourceVpc` / `aws:SourceIp`, `s3:x-amz-server-side-encryption`, `aws:SecureTransport`, `aws:PrincipalOrgID` ([architecture notes](./architecture.md#request-context-for-iam)). Operations declare the real ARNs (`arn:aws:s3:::bucket`, `arn:aws:s3:::bucket/key`) as resources for `authorize()`, and a request arriving through a gateway endpoint carries the endpoint context. Cross-account access needs both the bucket policy and the caller's identity policy.

## Quotas

Buckets per account, maximum object size for a single PUT and for multipart, parts per upload, part size, key length, tags per object: through the [quota registry](./quotas-plan.md), with hard limits recorded in the reference data.

## Steps

1. Store functions for buckets and objects (the encoding decision above), unit tests without HTTP.
2. REST XML protocol adapter, path-style routing, bucket and basic object operations, real errors.
3. Listing, ranges, conditional requests, copy, multipart, tagging, versioning (the layout already carries versions; this step adds the behaviour).
4. Virtual-hosted style and pre-signed URLs in the proxy and the shim.
5. Bucket policy and ACL evaluation once the policy engine exists; endpoint context for the perimeter scenarios.
6. Event notifications: configuration and its validation, the event record, the event log, delivery to Lambda once Lambda exists.
7. Consumers: CloudFormation `TemplateURL` and assets, Lambda code from S3.

## Open questions

- Key to file name encoding (above), and one metadata file per object versus one index per bucket. Per object keeps writes small and independent; a per bucket index lists faster.
- `db/` is partly tracked in git today. Object data must not be: add `db/s3/` to `.gitignore`, or keep S3 data under a separate root (`JPK_DB_ROOT` style variable).
- Disk use: allow a configurable size cap per bucket or per account, and a way to reset all S3 data.
- Regions: a bucket lives in one region; cross-region requests answer with the redirect/`PermanentRedirect` error like AWS.
