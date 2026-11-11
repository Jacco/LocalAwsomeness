#!/usr/bin/env python3
"""Minimal boto3 example against the local AWS simulator.

Nothing simulator-specific is in the code: boto3 takes the endpoint, region and credentials from the
normal AWS configuration, e.g. ~/.aws/config (or credentials):

    [default]
    endpoint_url = http://localhost:3000/
    region = eu-central-1

or AWS_ENDPOINT_URL / AWS_PROFILE / AWS_ACCESS_KEY_ID... in the environment. The simulator verifies the
SigV4 signature; the access key must be one it issued (bootstrap key from db/tokens.json, keys from
`sts assume-role` or `iam create-access-key`) and maps to the principal the request runs as.

S3 works with both virtual-hosted style (<bucket>.localhost:3000, botocore's default) and path style.

Run (with `npm run dev` up):
    python3 examples/boto3_basic.py
    AWS_PROFILE=prod python3 examples/boto3_basic.py
"""

import uuid

import boto3

sts, kms, s3 = boto3.client("sts"), boto3.client("kms"), boto3.client("s3")
print("caller:", sts.get_caller_identity()["Arn"])

# KMS (JSON protocol, X-Amz-Target: TrentService.<Operation>)
keys = kms.list_keys()["Keys"]
print(f"kms ListKeys: {len(keys)} key(s)")
if not keys:
    keys = [kms.create_key(Description="boto3_basic example")["KeyMetadata"]]
metadata = kms.describe_key(KeyId=keys[0]["KeyId"])["KeyMetadata"]
print(f"kms DescribeKey: {metadata['Arn']} state={metadata['KeyState']}")

# S3 (REST/XML protocol)
bucket = f"boto3-basic-{uuid.uuid4().hex[:8]}"
s3.create_bucket(Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": s3.meta.region_name})
print(f"s3 CreateBucket: {bucket}")

key, body = "greetings/hello.txt", b"Hello from boto3!\n"
etag = s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType="text/plain")["ETag"]
print(f"s3 PutObject: {key} etag={etag}")

got = s3.get_object(Bucket=bucket, Key=key)
data = got["Body"].read()
assert data == body, f"GetObject returned {data!r}"
print(f"s3 GetObject: {data!r} ({got['ContentType']}, {got['ContentLength']} bytes)")

keys = [o["Key"] for o in s3.list_objects_v2(Bucket=bucket).get("Contents", [])]
assert keys == [key], f"ListObjectsV2 returned {keys}"
print(f"s3 ListObjectsV2: {keys}")

print("OK")
