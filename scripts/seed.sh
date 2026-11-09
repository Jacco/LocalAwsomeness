#!/usr/bin/env bash
# Builds a simulated AWS organization by calling the local API through the AWS CLI.
#
# Prerequisites: the dev server is running (npm run dev) and the default profile holds the
# bootstrap key from db/tokens.json (management account). Safe to re-run: existing
# resources are looked up by name and reused.
#
# Member accounts are entered the way real AWS does it: sts assume-role into the
# OrganizationAccountAccessRole that organizations create-account provisions.
set -euo pipefail

export AWS_PAGER=""
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:3000/}"

REGIONS=(eu-west-1 eu-central-1)

log() { printf '==> %s\n' "$*" >&2; }

# Runs a command with credentials for a member account.
as_account() { # <account-id> <command...>
  local id=$1 creds key secret token
  shift
  creds=$(aws sts assume-role \
    --role-arn "arn:aws:iam::${id}:role/OrganizationAccountAccessRole" \
    --role-session-name seed \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
  read -r key secret token <<<"$creds"
  AWS_ACCESS_KEY_ID=$key AWS_SECRET_ACCESS_KEY=$secret AWS_SESSION_TOKEN=$token "$@"
}

ensure_ou() { # <parent-id> <name>
  local id
  id=$(aws organizations list-organizational-units-for-parent --parent-id "$1" \
    --query "OrganizationalUnits[?Name=='$2'].Id | [0]" --output text)
  if [ "$id" = None ]; then
    log "creating OU $2"
    id=$(aws organizations create-organizational-unit --parent-id "$1" --name "$2" \
      --query 'OrganizationalUnit.Id' --output text)
  fi
  echo "$id"
}

ensure_account() { # <name> <email>
  local id
  id=$(aws organizations list-accounts --query "Accounts[?Name=='$1'].Id | [0]" --output text)
  if [ "$id" = None ]; then
    log "creating account $1"
    id=$(aws organizations create-account --account-name "$1" --email "$2" \
      --query 'CreateAccountStatus.AccountId' --output text)
  fi
  echo "$id"
}

move_account() { # <account-id> <parent-id>
  local current
  current=$(aws organizations list-parents --child-id "$1" --query 'Parents[0].Id' --output text)
  if [ "$current" != "$2" ]; then
    log "moving account $1 to $2"
    aws organizations move-account --account-id "$1" --source-parent-id "$current" --destination-parent-id "$2"
  fi
}

ensure_scp() { # <name> <description> <content>
  local id
  id=$(aws organizations list-policies --filter SERVICE_CONTROL_POLICY \
    --query "Policies[?Name=='$1'].Id | [0]" --output text)
  if [ "$id" = None ]; then
    log "creating SCP $1"
    id=$(aws organizations create-policy --name "$1" --description "$2" --type SERVICE_CONTROL_POLICY \
      --content "$3" --query 'Policy.PolicySummary.Id' --output text)
  fi
  echo "$id"
}

attach_scp() { # <policy-id> <target-id>
  local attached
  attached=$(aws organizations list-targets-for-policy --policy-id "$1" \
    --query "Targets[?TargetId=='$2'] | length(@)" --output text)
  if [ "$attached" = 0 ]; then
    log "attaching $1 to $2"
    aws organizations attach-policy --policy-id "$1" --target-id "$2"
  fi
}

# Application baseline for one workload account: a role plus per-region SSM parameters.
seed_workload() { # <environment>
  local env=$1 region
  aws iam get-role --role-name app-role >/dev/null 2>&1 || aws iam create-role --role-name app-role \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name app-role --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess
  aws iam put-role-policy --role-name app-role --policy-name read-config \
    --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ssm:GetParameter","Resource":"arn:aws:ssm:*:*:parameter/app/*"}]}'
  for region in "${REGIONS[@]}"; do
    aws ssm put-parameter --region "$region" --name /app/environment --value "$env" --type String --overwrite >/dev/null
    aws ssm put-parameter --region "$region" --name /app/db-host --value "db.$env.$region.internal" --type String --overwrite >/dev/null
  done
}

MGMT=$(aws sts get-caller-identity --query Account --output text)
log "management account $MGMT"

if ! aws organizations describe-organization >/dev/null 2>&1; then
  log "creating organization"
  aws organizations create-organization --feature-set ALL >/dev/null
fi
ROOT=$(aws organizations list-roots --query 'Roots[0].Id' --output text)
if [ "$(aws organizations list-roots --query "Roots[0].PolicyTypes[?Type=='SERVICE_CONTROL_POLICY'] | length(@)" --output text)" = 0 ]; then
  log "enabling service control policies"
  aws organizations enable-policy-type --root-id "$ROOT" --policy-type SERVICE_CONTROL_POLICY >/dev/null
fi

WORKLOADS=$(ensure_ou "$ROOT" Workloads)
SANDBOX=$(ensure_ou "$ROOT" Sandbox)

PROD=$(ensure_account prod prod@example.com)
STAGING=$(ensure_account staging staging@example.com)
SANDBOX_ACCOUNT=$(ensure_account sandbox sandbox@example.com)
move_account "$PROD" "$WORKLOADS"
move_account "$STAGING" "$WORKLOADS"
move_account "$SANDBOX_ACCOUNT" "$SANDBOX"

DENY_REGIONS=$(ensure_scp DenyOutsideEurope "Only eu-west-1 and eu-central-1 may be used" \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","NotAction":["iam:*","organizations:*","sts:*"],"Resource":"*","Condition":{"StringNotEquals":{"aws:RequestedRegion":["eu-west-1","eu-central-1"]}}}]}')
attach_scp "$DENY_REGIONS" "$WORKLOADS"

log "seeding prod"
as_account "$PROD" seed_workload prod
log "seeding staging"
as_account "$STAGING" seed_workload staging
log "seeding sandbox"
as_account "$SANDBOX_ACCOUNT" seed_workload sandbox

cat <<EOF

management  $MGMT
prod        $PROD
staging     $STAGING
sandbox     $SANDBOX_ACCOUNT

Add to ~/.aws/config to work in a member account (here: prod):

[profile prod]
role_arn = arn:aws:iam::$PROD:role/OrganizationAccountAccessRole
source_profile = default
endpoint_url = http://localhost:3000/
EOF
