import boto3
import json
from pathlib import Path
import re
from collections import defaultdict
from botocore.exceptions import ClientError

session = boto3.Session(profile_name="dev")
iam = session.client("iam")
sts = session.client("sts")

IAM_REGION = "global"
IAM_SERVICE = "iam"
LAMBDA_SERVICE = "lambda"

REGIONS = [
    "eu-west-1",
    "eu-central-1",
]

# Services that should be emitted under each region directory (like lambda).
REGIONAL_RESOURCE_TYPE_SERVICES = {
    "cloudwatch",
    "ecr",
    "kms",
    "rds-db",
    "s3",
    "secretsmanager",
    "ssm",
}

# Keep this include pattern broad; service-role entries are explicitly excluded below.
pat = re.compile(r".*")

def list_role_policies(role_name: str) -> dict[str, dict]:
    paginator = iam.get_paginator("list_role_policies")
    policies: dict[str, dict] = {}
    for page in paginator.paginate(RoleName=role_name):
        for policy_name in page.get("PolicyNames", []):
            policy = iam.get_role_policy(RoleName=role_name, PolicyName=policy_name)
            policies[policy_name] = {
                "RoleName": policy["RoleName"],
                "PolicyName": policy["PolicyName"],
                "PolicyDocument": policy["PolicyDocument"],
            }
    return policies


def list_roles() -> tuple[dict[str, dict], dict[str, dict[str, dict]]]:
    paginator = iam.get_paginator('list_roles')
    roles: dict[str, dict] = {}
    role_policies: dict[str, dict[str, dict]] = {}

    for page in paginator.paginate():
        for role in page['Roles']:
            if 'service-role' in role['Path']:
                continue
            if not pat.search(role['RoleName']):
                continue

            role_name = role['RoleName']
            roles[role_name] = role
            role_policies[role_name] = list_role_policies(role_name)

    return roles, role_policies


def list_lambda_functions(region: str) -> dict[str, dict]:
    lambda_client = session.client("lambda", region_name=region)
    paginator = lambda_client.get_paginator("list_functions")
    functions: dict[str, dict] = {}

    for page in paginator.paginate():
        for fn in page.get("Functions", []):
            fn_name = fn["FunctionName"]
            functions[fn_name] = fn

    return functions


def _normalize_to_list(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str)]
    return []


def _extract_resource_type_from_arn(arn: str) -> str | None:
    if not arn.startswith("arn:"):
        return None

    parts = arn.split(":", 5)
    if len(parts) < 6:
        return None

    service = parts[2] or "unknown-service"
    resource = parts[5]

    if resource == "*":
        return f"{service}:*"

    # S3 bucket/object ARNs usually do not have an explicit resource type token.
    if service == "s3":
        if "/" in resource:
            return "s3:object"
        return "s3:bucket"

    if "/" in resource:
        resource_type = resource.split("/", 1)[0]
        return f"{service}:{resource_type}"

    if ":" in resource:
        resource_type = resource.split(":", 1)[0]
        return f"{service}:{resource_type}"

    return f"{service}:resource"


def collect_role_policy_resource_types(role_policies: dict[str, dict[str, dict]]) -> dict[str, dict[str, list[str]]]:
    by_role: dict[str, list[str]] = {}
    aggregate: dict[str, int] = defaultdict(int)

    for role_name, policies in role_policies.items():
        role_types: set[str] = set()
        for _, policy in policies.items():
            doc = policy.get("PolicyDocument", {})
            statements = doc.get("Statement", []) if isinstance(doc, dict) else []
            if isinstance(statements, dict):
                statements = [statements]
            for statement in statements:
                if not isinstance(statement, dict):
                    continue

                arns = _normalize_to_list(statement.get("Resource"))
                arns.extend(_normalize_to_list(statement.get("NotResource")))

                for arn in arns:
                    resource_type = _extract_resource_type_from_arn(arn)
                    if resource_type:
                        role_types.add(resource_type)

        sorted_types = sorted(role_types)
        by_role[role_name] = sorted_types
        for resource_type in sorted_types:
            aggregate[resource_type] += 1

    return {
        "by_role": by_role,
        "resource_type_counts": dict(sorted(aggregate.items())),
    }


def _resource_type_filename(resource_type: str) -> str:
    # Keep file names portable and deterministic across platforms.
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", resource_type)
    return f"{safe}.json"


def _resource_type_service(resource_type: str) -> str:
    if ":" in resource_type:
        return resource_type.split(":", 1)[0]
    return "unknown-service"


def _resource_types_from_role_policies(role_policies: dict[str, dict[str, dict]]) -> set[str]:
    found: set[str] = set()
    for _, policies in role_policies.items():
        for _, policy in policies.items():
            doc = policy.get("PolicyDocument", {})
            statements = doc.get("Statement", []) if isinstance(doc, dict) else []
            if isinstance(statements, dict):
                statements = [statements]
            for statement in statements:
                if not isinstance(statement, dict):
                    continue
                arns = _normalize_to_list(statement.get("Resource"))
                arns.extend(_normalize_to_list(statement.get("NotResource")))
                for arn in arns:
                    resource_type = _extract_resource_type_from_arn(arn)
                    if resource_type:
                        found.add(resource_type)
    return found


def _to_arn_keyed_object(resources: list[dict]) -> dict[str, dict]:
    """
    Convert a resource list to an object keyed by ARN.
    Falls back to arn_pattern for resources that are expressed as patterns.
    """
    keyed: dict[str, dict] = {}
    for item in resources:
        if not isinstance(item, dict):
            continue
        arn = item.get("arn")
        if not isinstance(arn, str) or not arn:
            arn_pattern = item.get("arn_pattern")
            arn = arn_pattern if isinstance(arn_pattern, str) and arn_pattern else None
        if not arn:
            continue

        value = dict(item)
        value.pop("arn", None)
        keyed[arn] = value
    return keyed


def _s3_bucket_region(s3_client, bucket_name: str) -> str:
    resp = s3_client.get_bucket_location(Bucket=bucket_name)
    loc = resp.get("LocationConstraint")
    if loc in (None, ""):
        return "us-east-1"
    if loc == "EU":
        return "eu-west-1"
    return str(loc)


def _list_region_s3_buckets(region: str) -> list[dict]:
    s3 = session.client("s3", region_name=region)
    buckets = []
    for b in s3.list_buckets().get("Buckets", []):
        name = b.get("Name")
        if not name:
            continue
        if _s3_bucket_region(s3, name) != region:
            continue
        buckets.append({
            "name": name,
            "creation_date": b.get("CreationDate"),
        })
    return buckets


def list_s3_bucket_policies(region: str) -> dict[str, dict]:
    s3 = session.client("s3", region_name=region)
    policies: dict[str, dict] = {}

    for bucket in _list_region_s3_buckets(region):
        name = bucket["name"]
        record = {
            "name": name,
            "arn": f"arn:aws:s3:::{name}",
            "region": region,
            "has_policy": False,
            "policy": None,
        }
        try:
            policy_response = s3.get_bucket_policy(Bucket=name)
            record["policy"] = json.loads(policy_response["Policy"])
            record["has_policy"] = True
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            if code not in {"NoSuchBucketPolicy", "NoSuchBucket", "AccessDenied", "AllAccessDisabled"}:
                record["error"] = code
        policies[name] = record

    return policies


def _list_resources_for_type(resource_type: str, region: str, account_id: str) -> list[dict]:
    if resource_type == "s3:bucket":
        return [
            {
                "name": b["name"],
                "arn": f"arn:aws:s3:::{b['name']}",
                "creation_date": b.get("creation_date"),
                "region": region,
            }
            for b in _list_region_s3_buckets(region)
        ]

    if resource_type == "s3:object":
        return []

    if resource_type == "cloudwatch:alarm":
        cw = session.client("cloudwatch", region_name=region)
        resources: list[dict] = []
        paginator = cw.get_paginator("describe_alarms")
        for page in paginator.paginate():
            for a in page.get("MetricAlarms", []):
                resources.append({
                    "name": a.get("AlarmName"),
                    "arn": a.get("AlarmArn"),
                    "state": a.get("StateValue"),
                })
            for a in page.get("CompositeAlarms", []):
                resources.append({
                    "name": a.get("AlarmName"),
                    "arn": a.get("AlarmArn"),
                    "state": a.get("StateValue"),
                })
        return resources

    if resource_type == "ecr:repository":
        ecr = session.client("ecr", region_name=region)
        resources = []
        paginator = ecr.get_paginator("describe_repositories")
        for page in paginator.paginate():
            for r in page.get("repositories", []):
                resources.append({
                    "name": r.get("repositoryName"),
                    "arn": r.get("repositoryArn"),
                    "uri": r.get("repositoryUri"),
                })
        return resources

    if resource_type == "kms:key":
        kms = session.client("kms", region_name=region)
        resources = []
        paginator = kms.get_paginator("list_keys")
        for page in paginator.paginate():
            for k in page.get("Keys", []):
                key_id = k.get("KeyId")
                entry: dict = {
                    "key_id": key_id,
                    "arn": k.get("KeyArn"),
                    "has_policy": False,
                    "key_policy": None,
                }
                try:
                    policy_resp = kms.get_key_policy(KeyId=key_id, PolicyName="default")
                    entry["key_policy"] = json.loads(policy_resp["Policy"])
                    entry["has_policy"] = True
                except ClientError as e:
                    entry["error"] = e.response.get("Error", {}).get("Code", "unknown")
                resources.append(entry)
        return resources

    if resource_type == "ssm:parameter":
        ssm = session.client("ssm", region_name=region)
        resources = []
        paginator = ssm.get_paginator("describe_parameters")
        for page in paginator.paginate():
            for p in page.get("Parameters", []):
                name = p.get("Name")
                if not name:
                    continue
                resources.append({
                    "name": name,
                    "arn": f"arn:aws:ssm:{region}:{account_id}:parameter/{name.lstrip('/')}",
                    "type": p.get("Type"),
                })
        return resources

    if resource_type == "secretsmanager:secret":
        sm = session.client("secretsmanager", region_name=region)
        resources = []
        paginator = sm.get_paginator("list_secrets")
        for page in paginator.paginate():
            for s in page.get("SecretList", []):
                arn = s.get("ARN")
                entry: dict = {
                    "name": s.get("Name"),
                    "arn": arn,
                    "has_policy": False,
                    "resource_policy": None,
                }
                try:
                    policy_resp = sm.get_resource_policy(SecretId=arn)
                    raw = policy_resp.get("ResourcePolicy")
                    if raw:
                        entry["resource_policy"] = json.loads(raw)
                        entry["has_policy"] = True
                except ClientError as e:
                    entry["error"] = e.response.get("Error", {}).get("Code", "unknown")
                resources.append(entry)
        return resources

    if resource_type.startswith("rds-db:dbuser"):
        rds = session.client("rds", region_name=region)
        resources = []
        for db in rds.describe_db_instances().get("DBInstances", []):
            dbi_resource_id = db.get("DbiResourceId")
            if not dbi_resource_id:
                continue
            resources.append({
                "db_instance_identifier": db.get("DBInstanceIdentifier"),
                "dbi_resource_id": dbi_resource_id,
                "arn_pattern": f"arn:aws:rds-db:{region}:{account_id}:dbuser:{dbi_resource_id}/*",
            })
        return resources

    return []


def dump_resource_type_files(root_dir: Path, resource_types: set[str], account_id: str) -> int:
    written = 0
    for resource_type in sorted(resource_types):
        service = _resource_type_service(resource_type)
        target_dirs: list[Path] = []

        if service in REGIONAL_RESOURCE_TYPE_SERVICES:
            for region in REGIONS:
                target_dirs.append(root_dir / region / service)
        else:
            target_dirs.append(root_dir / IAM_REGION / service)

        for service_dir in target_dirs:
            service_dir.mkdir(parents=True, exist_ok=True)
            region = service_dir.parts[-2] if service in REGIONAL_RESOURCE_TYPE_SERVICES else IAM_REGION
            resources = _list_resources_for_type(resource_type, region, account_id)
            payload = _to_arn_keyed_object(resources)
            output_path = service_dir / _resource_type_filename(resource_type)
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2, default=str)
            written += 1
    return written


def dump_to_json() -> None:
    account_id = sts.get_caller_identity()["Account"]
    root_dir = Path(account_id)

    roles, role_policies = list_roles()
    iam_dir = root_dir / IAM_REGION / IAM_SERVICE
    iam_dir.mkdir(parents=True, exist_ok=True)

    with open(iam_dir / "roles.json", "w", encoding="utf-8") as f:
        json.dump(roles, f, indent=2, default=str)

    with open(iam_dir / "role_policies.json", "w", encoding="utf-8") as f:
        json.dump(role_policies, f, indent=2)

    role_policy_resource_types = collect_role_policy_resource_types(role_policies)
    with open(iam_dir / "role_policy_resource_types.json", "w", encoding="utf-8") as f:
        json.dump(role_policy_resource_types, f, indent=2)

    resource_types = _resource_types_from_role_policies(role_policies)
    resource_files_written = dump_resource_type_files(root_dir, resource_types, account_id)

    print(f"[{IAM_REGION}] Saved {len(roles)} roles to {iam_dir / 'roles.json'} (keyed by RoleName)")
    print(f"[{IAM_REGION}] Saved inline role policy map to {iam_dir / 'role_policies.json'}")
    print(f"[{IAM_REGION}] Saved role policy resource types to {iam_dir / 'role_policy_resource_types.json'}")
    print(f"[{IAM_REGION}] Saved {resource_files_written} resource type files under service directories")

    for region in REGIONS:
        out_dir = root_dir / region / LAMBDA_SERVICE
        out_dir.mkdir(parents=True, exist_ok=True)

        lambda_functions = list_lambda_functions(region)

        with open(out_dir / "lambda_functions.json", "w", encoding="utf-8") as f:
            json.dump(lambda_functions, f, indent=2, default=str)

        print(f"[{region}] Saved {len(lambda_functions)} lambda functions to {out_dir / 'lambda_functions.json'} (keyed by FunctionName)")

        s3_dir = root_dir / region / "s3"
        s3_dir.mkdir(parents=True, exist_ok=True)
        s3_bucket_policies = list_s3_bucket_policies(region)
        with open(s3_dir / "s3_bucket_policies.json", "w", encoding="utf-8") as f:
            json.dump(s3_bucket_policies, f, indent=2, default=str)

        print(f"[{region}] Saved {len(s3_bucket_policies)} bucket policies to {s3_dir / 's3_bucket_policies.json'}")


dump_to_json()

