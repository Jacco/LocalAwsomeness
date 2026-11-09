import boto3
import json


def simulate_custom_policy_s3_access(
	bucket_name: str,
	profile_name: str = "dev",
	region_name: str = "eu-west-1",
) -> dict:
	"""Simulate whether a policy allows reading/listing from an S3 bucket."""
	session = boto3.Session(profile_name=profile_name, region_name=region_name)
	iam = session.client("iam")
	sts = session.client("sts")
	caller_identity = sts.get_caller_identity()
	account_id = caller_identity["Account"]
	caller_arn = f"arn:aws:iam::{account_id}:user/policy-simulator"
	resource_owner = f"arn:aws:iam::{account_id}:root"
	bucket_arn = f"arn:aws:s3:::{bucket_name}"
	object_arn = f"arn:aws:s3:::{bucket_name}/example.txt"

	policy_document = {
		"Version": "2012-10-17",
		"Statement": [
			{
				"Sid": "AllowListBucket",
				"Effect": "Allow",
				"Action": ["s3:ListBucket"],
				"Resource": [f"arn:aws:s3:::{bucket_name}"],
			},
			{
				"Sid": "AllowReadObjects",
				"Effect": "Allow",
				"Action": ["s3:GetObject"],
				"Resource": [f"arn:aws:s3:::{bucket_name}/*"],
			},
		],
	}

	resource_policy_document = {
		"Version": "2012-10-17",
		"Statement": [
			{
				"Sid": "AllowReadFromAnyPrincipal",
				"Effect": "Allow",
				"Principal": "*",
				"Action": ["s3:ListBucket", "s3:GetObject"],
				"Resource": [bucket_arn, f"{bucket_arn}/*"],
			}
		],
	}

	bucket_response = iam.simulate_custom_policy(
		PolicyInputList=[json.dumps(policy_document)],
		ActionNames=["s3:ListBucket"],
		ResourceArns=[bucket_arn],
		CallerArn=caller_arn,
		ResourcePolicy=json.dumps(resource_policy_document),
		ResourceOwner=resource_owner,
	)

	object_response = iam.simulate_custom_policy(
		PolicyInputList=[json.dumps(policy_document)],
		ActionNames=["s3:GetObject", "s3:PutObject"],
		ResourceArns=[object_arn],
		CallerArn=caller_arn,
		ResourcePolicy=json.dumps(resource_policy_document),
		ResourceOwner=resource_owner,
	)

	return {
		"EvaluationResults": [
			*bucket_response.get("EvaluationResults", []),
			*object_response.get("EvaluationResults", []),
		]
	}


def simultate_custom_policy(bucket_name: str) -> dict:
	"""Compatibility helper matching the requested method name."""
	return simulate_custom_policy_s3_access(bucket_name)


if __name__ == "__main__":
	bucket = "my-example-bucket"
	result = simulate_custom_policy_s3_access(bucket)

	for r in result.get("EvaluationResults", []):
		print(
			f"Action={r['EvalActionName']}, "
			f"Resource={r['EvalResourceName']}, "
			f"Decision={r['EvalDecision']}"
		)

