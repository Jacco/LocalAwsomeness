#!/usr/bin/env python3
"""Assume a role in another account through STS and use it to write to S3 in that account.

Flow:
  1. The base session (default AWS config, e.g. the bootstrap key) calls sts:AssumeRole on
     arn:aws:iam::<account>:role/<role>.
  2. A new boto3.Session is built from the temporary credentials (key, secret, session token).
  3. That session creates a bucket in the target account, puts an object and reads it back.
  4. The base identity's own account must not see the bucket: S3 data is kept per account.

The endpoint comes from the AWS config (endpoint_url = http://localhost:3000/ or AWS_ENDPOINT_URL).

Run (with `npm run dev` up and scripts/seed.sh applied):
    python3 examples/boto3_assume_role_s3.py                  # prod account (690025998313)
    python3 examples/boto3_assume_role_s3.py 993581059430     # another member account
    python3 examples/boto3_assume_role_s3.py --keep           # leave the bucket for inspection
"""

import argparse
import uuid

import boto3

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("account", nargs="?", default="690025998313", help="target account id (default: prod)")
parser.add_argument("--role", default="OrganizationAccountAccessRole", help="role name in the target account")
parser.add_argument("--keep", action="store_true", help="don't delete the bucket afterwards")
args = parser.parse_args()

base = boto3.session.Session()
base_identity = base.client("sts").get_caller_identity()
print(f"base identity:    {base_identity['Arn']}")

# 1. AssumeRole with the base credentials
role_arn = f"arn:aws:iam::{args.account}:role/{args.role}"
response = base.client("sts").assume_role(RoleArn=role_arn, RoleSessionName="boto3-assume-role-s3")
creds = response["Credentials"]
print(f"assumed:          {response['AssumedRoleUser']['Arn']} (expires {creds['Expiration']})")

# 2. A session that signs every request with the temporary credentials
assumed = boto3.session.Session(
    aws_access_key_id=creds["AccessKeyId"],
    aws_secret_access_key=creds["SecretAccessKey"],
    aws_session_token=creds["SessionToken"],
    region_name=base.region_name,
)
identity = assumed.client("sts").get_caller_identity()
assert identity["Account"] == args.account, f"expected account {args.account}, got {identity['Account']}"
print(f"assumed identity: {identity['Arn']}")

# 3. S3 in the target account
s3 = assumed.client("s3")
bucket = f"assume-role-demo-{uuid.uuid4().hex[:8]}"
s3.create_bucket(Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": s3.meta.region_name})
print(f"created bucket:   s3://{bucket} in {args.account}")

key, body = "reports/hello.txt", f"written by {identity['Arn']}\n".encode()
put = s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType="text/plain")
print(f"put object:       {key} etag={put['ETag']}")

data = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
assert data == body, f"GetObject returned {data!r}"
keys = [o["Key"] for o in s3.list_objects_v2(Bucket=bucket).get("Contents", [])]
assert keys == [key], f"ListObjectsV2 returned {keys}"
print(f"read back:        {data!r}")

# 4. The bucket lives in the target account, not in the base identity's account
if base_identity["Account"] != args.account:
    base_buckets = [b["Name"] for b in base.client("s3").list_buckets()["Buckets"]]
    assert bucket not in base_buckets, f"bucket unexpectedly visible from {base_identity['Account']}"
    print(f"isolation:        bucket not listed in base account {base_identity['Account']}")

if args.keep:
    print(f"kept:             s3://{bucket}")
else:
    s3.delete_object(Bucket=bucket, Key=key)
    s3.delete_bucket(Bucket=bucket)
    print(f"cleaned up:       s3://{bucket}")

print("OK")
