# S3 API Reference

**Service IAM Prefix**: `s3`  
**Protocol**: REST/XML (AWS S3 REST API)  
**Documentation**: [AWS S3 API Reference](https://docs.aws.amazon.com/AmazonS3/latest/API/)

---

## Overview

The S3 (Simple Storage Service) provides object storage with buckets and keys. In this simulator, S3 handles:
- Bucket creation, deletion, and lifecycle management
- Bucket policies for cross-account and cross-principal access
- Object upload, download, and deletion
- Object metadata and tagging
- Bucket ACLs and permissions
- Multi-account bucket ownership tracking

**Key Integration**: S3 operations include sophisticated cross-account access logic. Operations work on the bucket owner's storage, not the caller's account storage, enabling true multi-account bucket sharing scenarios.

---

## Implemented Operations

### Bucket Management

| # | Operation | HTTP | Path | IAM Action | Handler | Status |
|----|-----------|------|------|-----------|---------|--------|
| 1 | CreateBucket | PUT | `/api/s3/{BucketName}` | `s3:CreateBucket` | `s3.ts` | ✅ |
| 2 | DeleteBucket | DELETE | `/api/s3/{BucketName}` | `s3:DeleteBucket` | `s3.ts` | ✅ |
| 3 | ListBuckets | GET | `/api/s3` | `s3:ListAllMyBuckets` | `s3.ts` | ✅ |
| 4 | HeadBucket | HEAD | `/api/s3/{BucketName}` | `s3:HeadBucket` | `s3.ts` | ✅ |

### Bucket Policy

| # | Operation | HTTP | Path | IAM Action | Handler | Status |
|----|-----------|------|------|-----------|---------|--------|
| 5 | GetBucketPolicy | GET | `/api/s3/{BucketName}?policy` | `s3:GetBucketPolicy` | `s3.ts` | ✅ |
| 6 | PutBucketPolicy | PUT | `/api/s3/{BucketName}?policy` | `s3:PutBucketPolicy` | `s3.ts` | ✅ |
| 7 | DeleteBucketPolicy | DELETE | `/api/s3/{BucketName}?policy` | `s3:DeleteBucketPolicy` | `s3.ts` | ✅ |

### Object Operations

| # | Operation | HTTP | Path | IAM Action | Handler | Status |
|----|-----------|------|------|-----------|---------|--------|
| 8 | PutObject | PUT | `/api/s3/{BucketName}/{Key}` | `s3:PutObject` | `s3.ts` | ✅ |
| 9 | GetObject | GET | `/api/s3/{BucketName}/{Key}` | `s3:GetObject` | `s3.ts` | ✅ |
| 10 | DeleteObject | DELETE | `/api/s3/{BucketName}/{Key}` | `s3:DeleteObject` | `s3.ts` | ✅ |
| 11 | ListObjectsV2 | GET | `/api/s3/{BucketName}?list-type=2` | `s3:ListBucket` | `s3.ts` | ✅ |
| 12 | HeadObject | HEAD | `/api/s3/{BucketName}/{Key}` | `s3:GetObject` | `s3.ts` | ✅ |

---

## Not Yet Implemented

| # | Operation | Reason | Priority |
|----|-----------|--------|----------|
| 1 | ListObjectVersions | Object versioning | P2 | Needed for version-aware operations |
| 2 | DeleteObjects | Bulk delete | P2 | Multiple objects in single request |
| 3 | CopyObject | Object copying | P2 | Source/destination bucket logic |
| 4 | UploadPartCopy | Multipart upload | P2 | Needed for large object uploads |
| 5 | InitiateMultipartUpload | Multipart upload | P2 | Needed for large object uploads |
| 6 | UploadPart | Multipart upload | P2 | Needed for large object uploads |
| 7 | CompleteMultipartUpload | Multipart upload | P2 | Needed for large object uploads |
| 8 | PutBucketAcl | Bucket ACLs | P2 | Legacy ACL management |
| 9 | GetBucketAcl | Bucket ACLs | P2 | Legacy ACL management |
| 10 | PutBucketVersioning | Object versioning | P2 | Enable bucket versioning |
| 11 | GetBucketVersioning | Object versioning | P2 | Check if versioning enabled |

**Note**: Multipart uploads are important for large objects but lower priority than basic CRUD. Object versioning would enable point-in-time recovery.

---

## Common Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `AccessDenied` | 403 | Principal lacks required S3 permission |
| `InvalidAccessKeyId` | 403 | Access key not found or invalid |
| `AuthorizationHeaderMalformed` | 400 | Invalid authorization header |
| `NoSuchBucket` | 404 | Bucket does not exist |
| `NoSuchKey` | 404 | Object (key) does not exist |
| `BucketAlreadyExists` | 409 | Bucket name already taken (globally) |
| `BucketNotEmpty` | 409 | Cannot delete bucket with objects |
| `MalformedACL` | 400 | Invalid ACL format |
| `MalformedPolicy` | 400 | Invalid policy JSON |
| `InvalidPrincipal` | 400 | Invalid principal in policy |
| `NoSuchPolicy` | 404 | Bucket policy does not exist |

---

## Cross-Account Bucket Access

### Key Concept
In this simulator, S3 buckets are **globally scoped by name** but owned by a single account. When a principal from a different account tries to access a bucket:

1. **Ownership Check**: System finds the bucket and its owner account
2. **Policy Evaluation**: 
   - User's identity-based policies (from their own account)
   - Bucket's resource-based policy (from bucket owner account)
   - BOTH must allow the operation
3. **Storage Access**: Operation uses the bucket owner's storage namespace

### Example
```
Account A: owns bucket "shared-data"
Account B: user tries to access bucket "shared-data"

Access check:
1. Verify Account B user has s3:GetObject in their identity policies
2. Verify "shared-data" bucket policy Allows Account B user
3. If BOTH allow → Access granted
4. Operation reads from Account A's storage
```

---

## Implementation Details

### Handler Organization
```
src/app/api/s3/
├─ service.ts              (defineService + operation registry)
├─ route.ts                (Next.js API route handler)
├─ s3.ts                   (Core S3 operations)
├─ storage.ts              (Bucket/object storage backend)
├─ protocol.ts             (REST/XML protocol)
├─ policy.ts               (Bucket policy validation)
├─ [...path]/route.ts      (Dynamic object path handler)
└─ resources/
   └─ buckets/[bucket]/route.ts (Bucket resource handler)
```

### State Management
- **Storage**: `src/app/api/data/s3/` (buckets, objects, policies per account)
- **Cross-Account Logic**: `bucketOwner()` function resolves which account owns the bucket
- **Context Switch**: `s3Operation()` wrapper switches to bucket owner's account context
- **Policy Evaluation**: Evaluates both identity-based (caller) and resource-based (bucket owner) policies

### Bucket Ownership Resolution
```typescript
// From service.ts - bucketOwner() function
function bucketOwner({ params }: RequestContext): string | undefined {
  return typeof params.Bucket === 'string' 
    ? s3Storage.findBucketOwner(params.Bucket) 
    : undefined
}

// Example: User from Account B accesses bucket in Account A
const owner = bucketOwner(ctx)  // Returns Account A
const caller = ctx.account      // Account B

// Policies evaluated:
// 1. Account B's user identity policies
// 2. Account A's bucket policy
```

### Policy Evaluation
```typescript
function bucketPolicy(ctx: RequestContext): ResourcePolicy | undefined {
  const owner = bucketOwner(ctx)
  if (owner === undefined) return undefined
  
  const bucket = ctx.params.Bucket as string
  const document = s3Storage.getBucketPolicy(owner, bucket) ?? undefined
  
  return { 
    account: owner, 
    source: `bucket policy of ${bucket}`, 
    document: document as ResourcePolicy['document'] 
  }
}
```

---

## Testing

### Unit Tests
Location: `src/app/api/__tests__/s3.test.ts`

Test coverage includes:
- Bucket CRUD operations
- Object upload/download/delete
- Bucket policy creation and enforcement
- Cross-account access scenarios
- Permission validation

Run tests:
```bash
npm test -- s3.test.ts
```

### Integration Tests (Terraform)
Location: `tests/terraform/services/s3.tf`

Tests end-to-end S3 operations:
```bash
cd tests/terraform
terraform apply -target=module.s3_tests
```

---

## Examples

### Create a Bucket
```bash
curl -X PUT http://localhost:3000/api/s3/my-bucket \
  -H "Authorization: AWS4-HMAC-SHA256 ..."
```

### Put an Object
```bash
curl -X PUT http://localhost:3000/api/s3/my-bucket/my-key \
  -H "Authorization: AWS4-HMAC-SHA256 ..." \
  -d "object content here"
```

### Get an Object
```bash
curl -X GET http://localhost:3000/api/s3/my-bucket/my-key \
  -H "Authorization: AWS4-HMAC-SHA256 ..."

# Response: object content
```

### Set Bucket Policy (Cross-Account Access)
```bash
curl -X PUT http://localhost:3000/api/s3/my-bucket?policy \
  -H "Authorization: AWS4-HMAC-SHA256 ..." \
  -d '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::999888777666:root" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::my-bucket/*"
    }]
  }'
```

---

## Related Services

- **Authorization**: `src/app/auth/policy/` (evaluates identity and bucket policies)
- **Data Layer**: `src/app/api/data/s3/` (state storage per account)

---

## Recent Changes

### Phase 1 Refactoring (Nov 2026)
- Moved S3 resources from `src/app/api/resources/s3/` to `src/app/api/s3/resources/`
- S3 service implementation remains in `src/app/api/s3/`

### Phase 2 Standardization (In Progress)
- Creating uniform README documentation
- Standardizing operation definitions
- Planning multipart upload support

---

## Next Steps

1. Complete service standardization (KMS)
2. Add Terraform integration test framework
3. Implement multipart upload support
4. Add object versioning

---

## Questions?

Check `/docs/REFACTORING_READY_TO_START.md` for broader context or review test files for usage examples.
