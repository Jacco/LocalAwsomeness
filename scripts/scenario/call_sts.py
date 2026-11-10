"""The code of the walking-skeleton scenario: a function that asks STS who it is. Run it with scripts/run.py."""
import boto3
from botocore.config import Config

sts = boto3.client('sts', config=Config(connect_timeout=5))
try:
    identity = sts.get_caller_identity()
    print('I am', identity['Arn'], 'in account', identity['Account'])
except Exception as error:
    print('The call failed:', type(error).__name__, error)
    raise SystemExit(1)
