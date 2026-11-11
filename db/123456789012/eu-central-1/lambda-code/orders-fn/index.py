
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

def handler(event, context):
    config = Config(connect_timeout=2, retries={"max_attempts": 1})
    identity = boto3.client("sts", config=config).get_caller_identity()
    print("calling as", identity["Arn"])
    result = {"arn": identity["Arn"], "remaining_ms": context.get_remaining_time_in_millis()}
    # needs the permission ec2:DescribeVpcs, unlike sts:GetCallerIdentity, which needs none
    try:
        result["ec2"] = "ok, %d VPCs" % len(boto3.client("ec2", config=config).describe_vpcs()["Vpcs"])
    except ClientError as error:
        result["ec2"] = error.response["Error"]["Code"] + ": " + error.response["Error"]["Message"]
    print("ec2:", result["ec2"])
    return result
