#!/usr/bin/env python3
"""Cross-account S3 access: account B uses a bucket of account A through A's bucket policy.

Flow (both accounts are entered with sts:AssumeRole into OrganizationAccountAccessRole, from the default AWS config):
  1. A creates a bucket and puts an object.
  2. B cannot read it (no bucket policy grants B), and cannot take the bucket name (names are global).
  3. A puts a bucket policy that lets B's role read, write and list.
  4. B reads A's object and writes one of its own; the object lives in A's bucket, A can read it.
  5. What the policy does not grant stays denied (DeleteObject), the bucket is not in B's bucket list,
     and ExpectedBucketOwner protects B from writing to a bucket it did not expect.

Access across accounts needs both sides, as in AWS: the bucket policy of A must name B (its account or the role),
and the identity-based policies of B's role must allow the action (OrganizationAccountAccessRole can do everything).

Run (with `npm run dev` up and scripts/seed.sh applied):
    python3 examples/boto3_cross_account_s3.py                             # A = prod, B = staging
    python3 examples/boto3_cross_account_s3.py 690025998313 390209512651   # A, B
"""

import argparse
import json
import uuid

import boto3
from botocore.exceptions import ClientError

ROLE = "OrganizationAccountAccessRole"

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("owner", nargs="?", default="690025998313", help="account A, owns the bucket (default: prod)")
parser.add_argument("consumer", nargs="?", default="993581059430", help="account B, uses the bucket (default: staging)")
args = parser.parse_args()

base = boto3.session.Session()


def session_in(account):
    creds = base.client("sts").assume_role(
        RoleArn=f"arn:aws:iam::{account}:role/{ROLE}", RoleSessionName=f"cross-account-{account}"
    )["Credentials"]
    return boto3.session.Session(
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
        region_name=base.region_name,
    )


def error_code(call):
    try:
        call()
    except ClientError as e:
        return e.response["Error"]["Code"], e.response["Error"]["Message"]
    raise AssertionError("expected the call to fail")


s3_a = session_in(args.owner).client("s3")
s3_b = session_in(args.consumer).client("s3")
print(f"A = {args.owner}, B = {args.consumer}")

# 1. A creates a bucket with an object
bucket = f"cross-account-demo-{uuid.uuid4().hex[:8]}"
s3_a.create_bucket(Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": s3_a.meta.region_name})
s3_a.put_object(Bucket=bucket, Key="from-a.txt", Body=b"written by A\n")
print(f"A created s3://{bucket} with from-a.txt")

try:
    # 2. Without a bucket policy, B gets nowhere
    code, message = error_code(lambda: s3_b.get_object(Bucket=bucket, Key="from-a.txt"))
    assert code == "AccessDenied", code
    print(f"B GetObject before the policy:  {code} ({message.split(' because ')[-1]})")
    code, _ = error_code(lambda: s3_b.create_bucket(Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": s3_b.meta.region_name}))
    assert code == "BucketAlreadyExists", code
    print(f"B CreateBucket of the same name: {code}")

    # 3. A grants B's role read, write and list
    consumer_role = f"arn:aws:iam::{args.consumer}:role/{ROLE}"
    s3_a.put_bucket_policy(Bucket=bucket, Policy=json.dumps({
        "Version": "2012-10-17",
        "Statement": [
            {"Sid": "ListForB", "Effect": "Allow", "Principal": {"AWS": consumer_role},
             "Action": "s3:ListBucket", "Resource": f"arn:aws:s3:::{bucket}"},
            {"Sid": "ReadWriteForB", "Effect": "Allow", "Principal": {"AWS": consumer_role},
             "Action": ["s3:GetObject", "s3:PutObject"], "Resource": f"arn:aws:s3:::{bucket}/*"},
        ],
    }))
    print(f"A put a bucket policy granting {consumer_role}")

    # 4. B reads and writes in A's bucket
    data = s3_b.get_object(Bucket=bucket, Key="from-a.txt")["Body"].read()
    assert data == b"written by A\n", data
    print(f"B GetObject:  {data!r}")
    s3_b.put_object(Bucket=bucket, Key="from-b.txt", Body=b"written by B\n", ExpectedBucketOwner=args.owner)
    keys = [o["Key"] for o in s3_b.list_objects_v2(Bucket=bucket)["Contents"]]
    assert keys == ["from-a.txt", "from-b.txt"], keys
    print(f"B PutObject + ListObjectsV2: {keys}")
    data = s3_a.get_object(Bucket=bucket, Key="from-b.txt")["Body"].read()
    assert data == b"written by B\n", data
    print(f"A reads B's object: {data!r}")

    # 5. The limits
    code, message = error_code(lambda: s3_b.delete_object(Bucket=bucket, Key="from-a.txt"))
    assert code == "AccessDenied", code
    print(f"B DeleteObject (not granted): {code} ({message.split(' because ')[-1]})")
    assert bucket not in [b["Name"] for b in s3_b.list_buckets()["Buckets"]]
    print("B ListBuckets: the bucket of A is not listed")
    code, _ = error_code(lambda: s3_b.put_object(Bucket=bucket, Key="x", Body=b"x", ExpectedBucketOwner=args.consumer))
    assert code == "AccessDenied", code
    print(f"B PutObject expecting to own the bucket: {code}")
finally:
    for obj in s3_a.list_objects_v2(Bucket=bucket).get("Contents", []):
        s3_a.delete_object(Bucket=bucket, Key=obj["Key"])
    s3_a.delete_bucket(Bucket=bucket)
    print(f"A cleaned up s3://{bucket}")

print("OK")
