import boto3
import json
from pathlib import Path

session = boto3.Session(profile_name="dev")
client = session.client("iam")

OUTPUT = Path("data/aws/managed-policies.json")

contents = {}

# Keyed by the ARN part after "policy/", so path-prefixed policies appear as "service-role/<name>".
for page in client.get_paginator('list_policies').paginate(Scope='AWS'):
    for policy in page.get('Policies', []):
        arn = policy['Arn']
        obj = {}
        raw_versions = [v for vpage in client.get_paginator('list_policy_versions').paginate(PolicyArn=arn) for v in vpage['Versions']]
        obj['Versions'] = [v['VersionId'] for v in raw_versions]
        default_version = [v['VersionId'] for v in raw_versions if v['IsDefaultVersion'] == True][0]
        obj['PolicyId'] = policy['PolicyId']
        obj['DefaultVersion'] = default_version
        pinfo = client.get_policy(PolicyArn=arn)
        description = pinfo['Policy'].get('Description', '')
        if description:
            obj['Description'] = description
        tags = pinfo['Policy'].get('Tags', [])
        if tags:
            obj['Tags'] = tags
        pol = client.get_policy_version(PolicyArn=arn, VersionId=default_version)['PolicyVersion']['Document']
        obj['Document'] = {
            default_version: pol
        }
        contents[arn.split('policy/', 1)[1]] = obj

OUTPUT.write_text(json.dumps(contents, indent=2, default=str))
