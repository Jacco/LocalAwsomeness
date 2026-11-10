#!/usr/bin/env python3
"""The walking-skeleton scenario as a real Lambda function: `orders-fn` in the private subnet calls sts:GetCallerIdentity.

    python3 scripts/scenario/network.py --until B   # build the network (variants A, B, C or D)
    python3 scripts/scenario/lambda.py              # create orders-fn in it (or replace it), invoke it, show what happened
    python3 scripts/scenario/lambda.py --invoke     # invoke again (after changing the network or the permissions)
    python3 scripts/scenario/lambda.py --grant ec2:DescribeVpcs    # give the role a permission, then create and invoke
    python3 scripts/scenario/lambda.py --invoke --logs   # let the role write its log to CloudWatch Logs
    python3 scripts/scenario/lambda.py --revoke     # take the permissions away again
    python3 scripts/scenario/lambda.py --clean      # delete the function and the permissions

The function asks STS who it is (needs no permission, as in AWS) and calls ec2:DescribeVpcs (needs the permission): the role
starts without any policy, so the second call is denied until it is granted. Its log goes to CloudWatch Logs only when the
role may write there (logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents); without, nothing is written and, as in
AWS, nobody is told: the script prints why from the invocation record.

Uses the default AWS profile and endpoint like scripts/verify-ec2/check.py, through the Lambda API with boto3. The role
`orders-fn-role` (trusting lambda.amazonaws.com) is created when it does not exist. After the invocation it prints the
payload, the function log, and what the simulator recorded: every connection the code made with the trace of the decision
(GET /api/lambda/inspect). Invoke again, or change the network and invoke again: `scripts/scenario/lambda.py --invoke`.
"""
import io
import json
import os
import sys
import urllib.parse
import urllib.request
import zipfile

import boto3
from botocore.exceptions import ClientError

ENDPOINT = os.environ.get('AWS_ENDPOINT_URL', 'http://localhost:3000')
SERVER = os.environ.get('SIMULATOR_URL', ENDPOINT)
region = boto3.session.Session().region_name or 'eu-west-1'
lam = boto3.client('lambda', region_name=region, endpoint_url=ENDPOINT)
ec2 = boto3.client('ec2', region_name=region, endpoint_url=ENDPOINT)
iam = boto3.client('iam', region_name=region, endpoint_url=ENDPOINT)
sts = boto3.client('sts', region_name=region, endpoint_url=ENDPOINT)
logs = boto3.client('logs', region_name=region, endpoint_url=ENDPOINT)
NAME = 'orders-fn'
ROLE = 'orders-fn-role'
GRANT = 'orders-fn-grant'

CODE = '''
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
'''


def package():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('index.py', CODE)
    return buffer.getvalue()


def by_name(items, key, name):
    found = [i for i in items if any(t['Key'] == 'Name' and t['Value'] == name for t in i.get('Tags', []))]
    if not found:
        sys.exit(f'No {key} named {name}: run scripts/scenario/network.py first')
    return found[0]


def ensure_role():
    try:
        return iam.get_role(RoleName=ROLE)['Role']['Arn']
    except ClientError:
        trust = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Principal': {'Service': 'lambda.amazonaws.com'}, 'Action': 'sts:AssumeRole'}]}
        return iam.create_role(RoleName=ROLE, AssumeRolePolicyDocument=json.dumps(trust))['Role']['Arn']


def delete():
    try:
        lam.delete_function(FunctionName=NAME)
        print(f'deleted {NAME}')
    except ClientError as error:
        if error.response['Error']['Code'] != 'ResourceNotFoundException':
            raise


def create():
    subnet = by_name(ec2.describe_subnets()['Subnets'], 'subnet', 'skeleton-private')
    group = by_name(ec2.describe_security_groups()['SecurityGroups'], 'security group', 'skeleton-fn')
    delete()
    configuration = lam.create_function(
        FunctionName=NAME, Runtime='python3.12', Role=ensure_role(), Handler='index.handler', Code={'ZipFile': package()},
        Timeout=10, MemorySize=128, VpcConfig={'SubnetIds': [subnet['SubnetId']], 'SecurityGroupIds': [group['GroupId']]})
    print(f'created {configuration["FunctionArn"]} state={configuration["State"]} vpc={configuration["VpcConfig"]["VpcId"]}')
    interfaces = ec2.describe_network_interfaces(Filters=[{'Name': 'subnet-id', 'Values': [subnet['SubnetId']]}])['NetworkInterfaces']
    for eni in interfaces:
        print(f'  interface {eni["NetworkInterfaceId"]} {eni["PrivateIpAddress"]} {eni.get("InterfaceType")} "{eni["Description"]}"')


def invoke():
    account = sts.get_caller_identity()['Account']
    answer = lam.invoke(FunctionName=NAME, LogType='Tail')
    payload = answer['Payload'].read().decode()
    print('\n--- result ---')
    print('status', answer['StatusCode'], 'error' if answer.get('FunctionError') else 'ok')
    print(payload)
    import base64
    print('\n--- log returned by Invoke (LogType=Tail) ---')
    print(base64.b64decode(answer['LogResult']).decode(), end='')
    query = urllib.parse.urlencode({'account': account, 'region': region, 'function': NAME})
    with urllib.request.urlopen(f'{SERVER}/api/lambda/inspect?{query}') as response:
        record = json.load(response)['invocations'][0]
    delivery = record['LogDelivery']
    print(f'\n--- CloudWatch Logs: {delivery["Group"]} ---')
    if delivery['Status'] == 'written':
        events = logs.get_log_events(logGroupName=delivery['Group'], logStreamName=delivery['Stream'], startFromHead=True)['events']
        print(f'stream {delivery["Stream"]}')
        for event in events:
            print('  ', event['message'].rstrip())
    else:
        print('nothing was written (AWS does not tell the function or the caller):')
        print(' ', delivery['Reason'])
        print(f'  give the role logs:CreateLogGroup, logs:CreateLogStream and logs:PutLogEvents: {sys.argv[0]} --invoke --logs')
    print('\n--- network (what the simulator recorded) ---')
    print('\n'.join(record['Network']))


def grant(actions):
    # add to what was granted before
    try:
        existing = iam.get_role_policy(RoleName=ROLE, PolicyName=GRANT)['PolicyDocument']
        existing = json.loads(existing) if isinstance(existing, str) else existing
        actions = sorted(set(existing['Statement'][0]['Action']) | set(actions))
    except ClientError:
        pass
    document = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Action': actions, 'Resource': '*'}]}
    iam.put_role_policy(RoleName=ROLE, PolicyName=GRANT, PolicyDocument=json.dumps(document))
    print(f'{ROLE} may now: {", ".join(actions)}')


def revoke():
    try:
        iam.delete_role_policy(RoleName=ROLE, PolicyName=GRANT)
        print(f'removed the permissions granted to {ROLE}')
    except ClientError as error:
        if error.response['Error']['Code'] != 'NoSuchEntity':
            raise


if __name__ == '__main__':
    try:
        if '--clean' in sys.argv:
            delete()
            revoke()
        else:
            ensure_role()
            if '--revoke' in sys.argv:
                revoke()
            actions = []
            if '--grant' in sys.argv:
                actions += sys.argv[sys.argv.index('--grant') + 1].split(',')
            if '--logs' in sys.argv:
                actions += ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents']
            if actions:
                grant(actions)
            if '--invoke' not in sys.argv:
                create()
            invoke()
    except ClientError as error:
        sys.exit(f'{error.response["Error"]["Code"]}: {error.response["Error"]["Message"]}')
