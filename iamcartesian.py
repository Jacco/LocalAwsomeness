"""
Cartesian IAM simulation: for every role x every allowed action x every matching resource,
call simulate_custom_policy and print a table of (role, action, resource, decision).

Only inline role policies are tested (managed policies attached to roles are not included).
Wildcard actions (e.g. s3:* or *) are skipped because the IAM simulator requires specific
action names.

Results are also saved to <account>/global/iam/simulation_results.csv.
"""

import boto3
import csv
import fnmatch
import json
import sys
from collections import defaultdict
from pathlib import Path

PROFILE = "dev"
REGIONS = ["eu-west-1", "eu-central-1"]
CHUNK_SIZE = 20  # (actions x resources) must stay <= 1000; 20x20=400 is safe

session = boto3.Session(profile_name=PROFILE)
iam_client = session.client("iam")
account_id = session.client("sts").get_caller_identity()["Account"]
caller_arn = f"arn:aws:iam::{account_id}:user/policy-simulator"
resource_owner = f"arn:aws:iam::{account_id}:root"
base = Path(account_id)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_json(path: Path):
    return json.loads(path.read_text()) if path.exists() else None


def normalize_to_list(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str)]
    return []


def chunked(lst: list, size: int):
    for i in range(0, len(lst), size):
        yield lst[i : i + size]


def get_dumped_services() -> set[str]:
    """
    Detect which services have dumped resources by checking directory structure.
    Returns set of service prefixes (e.g., {'s3', 'kms', 'lambda', 'ssm', 'ecr', ...}).
    """
    dumped = set()
    
    # Check regional services
    for region in REGIONS:
        region_path = base / region
        if region_path.exists():
            for service_dir in region_path.iterdir():
                if service_dir.is_dir():
                    dumped.add(service_dir.name)
    
    # Check global services (IAM)
    if (base / "global" / "iam").exists():
        dumped.add("iam")
    
    return dumped


# ---------------------------------------------------------------------------
# Resource registry: {arn -> serialized_resource_policy_or_None}
#   Files written by dumpaws.py use {"resource_type":…, "service":…, "region":…, "resources":[…]}
#   except s3_bucket_policies.json which is keyed by bucket name.
# ---------------------------------------------------------------------------

def build_resource_registry() -> dict[str, str | None]:
    registry: dict[str, str | None] = {}

    for region in REGIONS:
        # --- S3 buckets (s3_bucket_policies.json is keyed by bucket name) ---
        s3_data = load_json(base / region / "s3" / "s3_bucket_policies.json")
        if isinstance(s3_data, dict):
            for _, info in s3_data.items():
                arn = info.get("arn")
                if arn:
                    policy = info.get("policy")
                    registry[arn] = json.dumps(policy) if policy else None

        # --- Standard resource files (resources list) ---
        for svc, fname, policy_key in [
            ("kms",            "kms_key.json",                "key_policy"),
            ("secretsmanager", "secretsmanager_secret.json",  "resource_policy"),
            ("ssm",            "ssm_parameter.json",          None),
            ("ecr",            "ecr_repository.json",         None),
            ("cloudwatch",     "cloudwatch_alarm.json",       None),
        ]:
            data = load_json(base / region / svc / fname)
            if isinstance(data, dict):
                # Backward compatible: support both
                # 1) {"resources": [{"arn": ...}, ...]} and
                # 2) {"arn:...": {...}, "arn:...": {...}}
                if isinstance(data.get("resources"), list):
                    for item in data.get("resources", []):
                        arn = item.get("arn")
                        if arn:
                            policy = item.get(policy_key) if policy_key else None
                            registry[arn] = json.dumps(policy) if policy else None
                else:
                    for arn, item in data.items():
                        if not isinstance(arn, str) or not arn.startswith("arn:"):
                            continue
                        policy = item.get(policy_key) if (policy_key and isinstance(item, dict)) else None
                        registry[arn] = json.dumps(policy) if policy else None

        # Lambda dump is keyed by function name, not resources[]
        lambda_data = load_json(base / region / "lambda" / "lambda_functions.json")
        if isinstance(lambda_data, dict):
            for fn in lambda_data.values():
                if isinstance(fn, dict):
                    arn = fn.get("FunctionArn")
                    if arn:
                        registry[arn] = None

    return registry


# ---------------------------------------------------------------------------
# Policy analysis
# ---------------------------------------------------------------------------

def get_all_resource_arns(registry: dict[str, str | None]) -> list[str]:
    """Return a sorted list of every dumped resource ARN."""
    return sorted(registry.keys())


def get_action_patterns(policy_docs: list[dict]) -> list[str]:
    """
    Collect all Allow action strings from policy documents.
    Returns raw patterns as written in the policy, including wildcards like 'kms:*'.
    """
    actions: set[str] = set()
    for doc in policy_docs:
        stmts = doc.get("Statement", [])
        if isinstance(stmts, dict):
            stmts = [stmts]
        for stmt in stmts:
            if isinstance(stmt, dict) and stmt.get("Effect") == "Allow":
                for action in normalize_to_list(stmt.get("Action", [])):
                    actions.add(action)
    return sorted(actions)


def get_resource_patterns(
    policy_docs: list[dict],
    all_arns: list[str],
) -> list[str]:
    """
    Collect resource patterns from Allow statements.
    Explicit patterns (e.g. 'arn:aws:s3:::my-bucket*') are returned as-is.
    A bare '*' is expanded: look at the actions in that statement to determine
    which service(s) are referenced, then include all dumped ARNs for those services.
    """
    arns_by_service: dict[str, list[str]] = defaultdict(list)
    for arn in all_arns:
        parts = arn.split(":")
        if len(parts) >= 3:
            arns_by_service[parts[2].lower()].append(arn)

    patterns: set[str] = set()

    for doc in policy_docs:
        stmts = doc.get("Statement", [])
        if isinstance(stmts, dict):
            stmts = [stmts]
        for stmt in stmts:
            if not isinstance(stmt, dict) or stmt.get("Effect") != "Allow":
                continue
            stmt_resources = normalize_to_list(stmt.get("Resource", []))
            stmt_actions = normalize_to_list(stmt.get("Action", []))
            for resource in stmt_resources:
                if resource == "*":
                    # Expand to dumped ARNs for every service this statement's actions target
                    for action in stmt_actions:
                        if ":" in action:
                            service = action.split(":")[0].lower()
                            patterns.update(arns_by_service.get(service, []))
                else:
                    patterns.add(resource)

    return sorted(patterns)


def match_resources(patterns: list[str], all_arns: list[str]) -> list[str]:
    """Expand glob patterns to the concrete ARNs in the registry that match them."""
    matched: set[str] = set()
    for arn in all_arns:
        for pattern in patterns:
            if fnmatch.fnmatch(arn, pattern):
                matched.add(arn)
                break
    return sorted(matched)


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------

ACCOUNT_LEVEL_SERVICES = frozenset({
    "sts", "iam", "organizations", "sso", "controltower", "sso-directory",
})

# Concrete actions to substitute when a policy grants "service:*"
WILDCARD_EXPANSIONS: dict[str, list[str]] = {
    "kms":            ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey", "kms:Encrypt"],
    "s3":             ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:DeleteObject"],
    "lambda":         ["lambda:InvokeFunction", "lambda:GetFunction"],
    "ssm":            ["ssm:GetParameter", "ssm:PutParameter", "ssm:GetParameters"],
    "secretsmanager": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret",
                       "secretsmanager:ListSecretVersionIds"],
    "ecr":            ["ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:PutImage"],
}


def simulate_role(
    role_name: str,
    policy_docs: list[dict],
    registry: dict[str, str | None],
    dumped_services: set[str],
) -> list[dict]:
    # Step 1: raw action patterns from the policy
    action_patterns = get_action_patterns(policy_docs)

    # Step 2: all dumped resource ARNs
    all_arns = get_all_resource_arns(registry)

    # Step 3: resource patterns — bare '*' is already expanded to concrete ARNs
    #         based on the services referenced by the actions in that statement
    resource_patterns = get_resource_patterns(policy_docs, all_arns)

    if not action_patterns or not resource_patterns:
        return []

    # Expand and filter action patterns to concrete, testable action names
    concrete_actions: set[str] = set()
    for action in action_patterns:
        if action == "*" or ":" not in action:
            continue
        service = action.split(":")[0].lower()
        if service in ACCOUNT_LEVEL_SERVICES or service not in dumped_services:
            continue
        if action.endswith(":*"):
            concrete_actions.update(WILDCARD_EXPANSIONS.get(service, []))
        else:
            concrete_actions.add(action)

    if not concrete_actions:
        return []

    # Expand any glob patterns (e.g. arn:aws:s3:::my-bucket*) to concrete ARNs
    concrete_arns = match_resources(resource_patterns, all_arns)
    if not concrete_arns:
        return []

    # Group ARNs and actions by service so we can simulate service by service
    arns_by_service: dict[str, list[str]] = defaultdict(list)
    for arn in concrete_arns:
        parts = arn.split(":")
        if len(parts) >= 3:
            arns_by_service[parts[2].lower()].append(arn)

    actions_by_service: dict[str, list[str]] = defaultdict(list)
    for action in concrete_actions:
        actions_by_service[action.split(":")[0].lower()].append(action)

    results: list[dict] = []

    for service, service_actions in actions_by_service.items():
        service_arns = arns_by_service.get(service, [])
        if not service_arns:
            continue

        # Build synthetic policies: replace bare '*' Resource with the service-specific ARNs.
        # The IAM simulator rejects a request where the policy has Resource="*" but we pass
        # a specific ARN in ResourceArns ("ResourceNames are not in a valid ARN format: *").
        synthetic_docs = []
        for doc in policy_docs:
            synthetic = json.loads(json.dumps(doc))
            stmts = synthetic.get("Statement", [])
            if isinstance(stmts, dict):
                stmts = [stmts]
                synthetic["Statement"] = stmts
            for stmt in stmts:
                if isinstance(stmt, dict) and stmt.get("Effect") == "Allow":
                    if "*" in normalize_to_list(stmt.get("Resource", [])):
                        stmt["Resource"] = service_arns
            synthetic_docs.append(synthetic)

        policy_input = [json.dumps(doc) for doc in synthetic_docs]

        action_chunk_size = 1 if service == "kms" else CHUNK_SIZE
        for arn in service_arns:
            resource_policy = registry.get(arn) or ""
            for action_chunk in chunked(service_actions, action_chunk_size):
                call_kwargs: dict = {
                    "PolicyInputList": policy_input,
                    "ActionNames":     action_chunk,
                    "ResourceArns":    [arn],
                    "CallerArn":       caller_arn,
                    "ResourceOwner":   resource_owner,
                }
                # KMS key policies often use Resource="*" which the simulator rejects
                # in this request shape; evaluate KMS with identity policy only.
                if resource_policy and service != "kms":
                    call_kwargs["ResourcePolicy"] = resource_policy
                try:
                    resp = iam_client.simulate_custom_policy(**call_kwargs)
                    for r in resp.get("EvaluationResults", []):
                        results.append({
                            "role":            role_name,
                            "action":          r["EvalActionName"],
                            "resource":        r["EvalResourceName"],
                            "decision":        r["EvalDecision"],
                            "resource_policy": resource_policy,
                        })
                except Exception as exc:
                    print(
                        f"  WARNING [{role_name}] actions={action_chunk[:2]}… arn={arn}: {exc}",
                        file=sys.stderr,
                    )

    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("Detecting dumped services…", file=sys.stderr)
    dumped_services = get_dumped_services()
    print(f"  Services with dumped resources: {sorted(dumped_services)}", file=sys.stderr)

    print("Building resource registry…", file=sys.stderr)
    registry = build_resource_registry()
    print(f"  {len(registry)} resource ARNs indexed across {REGIONS}", file=sys.stderr)

    role_policies_data = load_json(base / "global" / "iam" / "role_policies.json") or {}
    roles_with_policies = [(r, v) for r, v in role_policies_data.items() if v]
    print(f"  {len(roles_with_policies)} roles have inline policies", file=sys.stderr)

    all_results: list[dict] = []

    for role_name, policies in roles_with_policies:
        policy_docs = [
            p["PolicyDocument"]
            for p in policies.values()
            if isinstance(p.get("PolicyDocument"), dict)
        ]
        if not policy_docs:
            continue
        print(f"  → {role_name}", file=sys.stderr)
        all_results.extend(simulate_role(role_name, policy_docs, registry, dumped_services))

    all_results.sort(key=lambda r: (r["role"], r["action"], r["resource"]))

    # --- Print table ---
    if all_results:
        w_role     = max(len("Role"),     max(len(r["role"])     for r in all_results))
        w_action   = max(len("Action"),   max(len(r["action"])   for r in all_results))
        w_resource = max(len("Resource"), max(len(r["resource"]) for r in all_results))
        w_decision = max(len("Decision"), max(len(r["decision"]) for r in all_results))

        fmt = f"{{:<{w_role}}}  {{:<{w_action}}}  {{:<{w_resource}}}  {{:<{w_decision}}}"
        sep = "-" * (w_role + w_action + w_resource + w_decision + 6)

        print(fmt.format("Role", "Action", "Resource", "Decision"))
        print(sep)
        for r in all_results:
            print(fmt.format(r["role"], r["action"], r["resource"], r["decision"]))
    else:
        print("No simulation results.")

    # --- Save CSV ---
    out_csv = base / "global" / "iam" / "simulation_results.csv"
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["role", "action", "resource", "decision", "resource_policy"])
        writer.writeheader()
        writer.writerows(all_results)

    print(f"\nSaved {len(all_results)} rows → {out_csv}", file=sys.stderr)


if __name__ == "__main__":
    main()
