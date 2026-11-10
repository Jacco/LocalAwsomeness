#!/usr/bin/env bash
# EC2 networking check (phases 2 and 3) with the AWS CLI against the local dev server.
#
#   scripts/verify-ec2/check.sh
#
# Uses the default AWS profile (the bootstrap key of db/tokens.json); the endpoint is AWS_ENDPOINT_URL or
# http://localhost:3000. Everything it creates is deleted again, also when a step fails.
set -euo pipefail

export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:3000}"
export AWS_DEFAULT_REGION=eu-west-1
export AWS_PAGER=""
aws() { command aws "$@" --output text; }

VPC="" ; IGW="" ; RTB="" ; SUBNET="" ; WEB="" ; DB="" ; ACL="" ; NAT="" ; EIP="" ; NATSUBNET="" ; NATRTB="" ; NATIGW=""
cleanup() {
  set +e
  [ -n "$NATRTB" ] && aws ec2 delete-route --route-table-id "$NATRTB" --destination-cidr-block 0.0.0.0/0 >/dev/null 2>&1
  [ -n "$NATRTB" ] && aws ec2 delete-route-table --route-table-id "$NATRTB" >/dev/null 2>&1
  [ -n "$NAT" ] && aws ec2 delete-nat-gateway --nat-gateway-id "$NAT" >/dev/null 2>&1
  [ -n "$EIP" ] && aws ec2 release-address --allocation-id "$EIP" >/dev/null 2>&1
  [ -n "$NATIGW" ] && aws ec2 detach-internet-gateway --internet-gateway-id "$NATIGW" --vpc-id "$VPC" >/dev/null 2>&1
  [ -n "$NATIGW" ] && aws ec2 delete-internet-gateway --internet-gateway-id "$NATIGW" >/dev/null 2>&1
  [ -n "$NATSUBNET" ] && aws ec2 delete-subnet --subnet-id "$NATSUBNET" >/dev/null 2>&1
  [ -n "$DB" ] && aws ec2 delete-security-group --group-id "$DB" >/dev/null 2>&1
  [ -n "$WEB" ] && aws ec2 delete-security-group --group-id "$WEB" >/dev/null 2>&1
  if [ -n "$ACL" ]; then
    ASSOC=$(aws ec2 describe-network-acls --network-acl-ids "$ACL" --query 'NetworkAcls[0].Associations[0].NetworkAclAssociationId' 2>/dev/null)
    DEFAULT_ACL=$(aws ec2 describe-network-acls --filters Name=vpc-id,Values="$VPC" Name=default,Values=true --query 'NetworkAcls[0].NetworkAclId' 2>/dev/null)
    [ -n "$ASSOC" ] && [ "$ASSOC" != None ] && aws ec2 replace-network-acl-association --association-id "$ASSOC" --network-acl-id "$DEFAULT_ACL" >/dev/null 2>&1
    aws ec2 delete-network-acl --network-acl-id "$ACL" >/dev/null 2>&1
  fi
  if [ -n "$RTB" ]; then
    for A in $(aws ec2 describe-route-tables --route-table-ids "$RTB" --query 'RouteTables[0].Associations[].RouteTableAssociationId' 2>/dev/null); do
      aws ec2 disassociate-route-table --association-id "$A" >/dev/null 2>&1
    done
    aws ec2 delete-route-table --route-table-id "$RTB" >/dev/null 2>&1
  fi
  [ -n "$IGW" ] && aws ec2 detach-internet-gateway --internet-gateway-id "$IGW" --vpc-id "$VPC" >/dev/null 2>&1
  [ -n "$IGW" ] && aws ec2 delete-internet-gateway --internet-gateway-id "$IGW" >/dev/null 2>&1
  [ -n "$SUBNET" ] && aws ec2 delete-subnet --subnet-id "$SUBNET" >/dev/null 2>&1
  [ -n "$VPC" ] && aws ec2 delete-vpc --vpc-id "$VPC" >/dev/null 2>&1
}
trap cleanup EXIT

fail() { echo "FAILED: $*"; exit 1; }
expect() { # expect <text> <command...>: the command must fail and its error must contain the text
  local text="$1"; shift
  local out; out=$("$@" 2>&1) && fail "expected an error containing '$text' from: $*"
  grep -q "$text" <<<"$out" || fail "expected '$text', got: $out"
}
equals() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }

VPC=$(aws ec2 create-vpc --cidr-block 10.89.0.0/16 --query Vpc.VpcId)

# --- internet gateway and route table (phase 2) ---
IGW=$(aws ec2 create-internet-gateway --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=cli}]' --query InternetGateway.InternetGatewayId)
aws ec2 attach-internet-gateway --internet-gateway-id "$IGW" --vpc-id "$VPC"
expect DependencyViolation aws ec2 delete-internet-gateway --internet-gateway-id "$IGW"
SUBNET=$(aws ec2 create-subnet --vpc-id "$VPC" --cidr-block 10.89.1.0/24 --availability-zone eu-west-1a --query Subnet.SubnetId)
RTB=$(aws ec2 create-route-table --vpc-id "$VPC" --query RouteTable.RouteTableId)
aws ec2 create-route --route-table-id "$RTB" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW" >/dev/null
ASSOC=$(aws ec2 associate-route-table --route-table-id "$RTB" --subnet-id "$SUBNET" --query AssociationId)
equals "$(aws ec2 describe-route-tables --filters Name=association.subnet-id,Values="$SUBNET" --query 'RouteTables[0].RouteTableId')" "$RTB"
expect DependencyViolation aws ec2 delete-route-table --route-table-id "$RTB"
aws ec2 disassociate-route-table --association-id "$ASSOC"
echo "ok  internet gateway and route table"

# --- security groups (phase 3) ---
WEB=$(aws ec2 create-security-group --group-name cli-web --description "web" --vpc-id "$VPC" --query GroupId)
DB=$(aws ec2 create-security-group --group-name cli-db --description "db" --vpc-id "$VPC" --query GroupId)
aws ec2 authorize-security-group-ingress --group-id "$WEB" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
aws ec2 authorize-security-group-ingress --group-id "$DB" --ip-permissions \
  "IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=[{GroupId=$WEB,Description=from web}]" >/dev/null
expect InvalidPermission.Duplicate aws ec2 authorize-security-group-ingress --group-id "$WEB" --protocol tcp --port 443 --cidr 0.0.0.0/0
equals "$(aws ec2 describe-security-groups --group-ids "$DB" --query 'SecurityGroups[0].IpPermissions[0].UserIdGroupPairs[0].GroupId')" "$WEB"
RULE=$(aws ec2 describe-security-group-rules --filters Name=group-id,Values="$WEB" --query 'SecurityGroupRules[?IsEgress==`false`].SecurityGroupRuleId')
aws ec2 modify-security-group-rules --group-id "$WEB" \
  --security-group-rules "SecurityGroupRuleId=$RULE,SecurityGroupRule={IpProtocol=tcp,FromPort=8443,ToPort=8443,CidrIpv4=10.0.0.0/8}" >/dev/null
equals "$(aws ec2 describe-security-group-rules --security-group-rule-ids "$RULE" --query 'SecurityGroupRules[0].FromPort')" 8443
expect DependencyViolation aws ec2 delete-security-group --group-id "$WEB"
aws ec2 revoke-security-group-ingress --group-id "$WEB" --security-group-rule-ids "$RULE" >/dev/null
echo "ok  security groups"

# --- network ACL (phase 3) ---
ACL=$(aws ec2 create-network-acl --vpc-id "$VPC" --query NetworkAcl.NetworkAclId)
aws ec2 create-network-acl-entry --network-acl-id "$ACL" --rule-number 100 --protocol tcp --port-range From=80,To=80 --cidr-block 10.1.2.3/16 --rule-action allow --ingress
aws ec2 create-network-acl-entry --network-acl-id "$ACL" --rule-number 100 --protocol -1 --cidr-block 0.0.0.0/0 --rule-action allow --egress
equals "$(aws ec2 describe-network-acls --network-acl-ids "$ACL" --query 'NetworkAcls[0].Entries[?RuleNumber==`100` && Egress==`false`].CidrBlock')" 10.1.0.0/16
aws ec2 replace-network-acl-entry --network-acl-id "$ACL" --rule-number 100 --protocol tcp --port-range From=81,To=81 --cidr-block 10.1.0.0/16 --rule-action deny --ingress
equals "$(aws ec2 describe-network-acls --network-acl-ids "$ACL" --query 'NetworkAcls[0].Entries[?RuleNumber==`100` && Egress==`false`].RuleAction')" deny
CURRENT=$(aws ec2 describe-network-acls --filters Name=association.subnet-id,Values="$SUBNET" --query 'NetworkAcls[0].Associations[?SubnetId==`'"$SUBNET"'`].NetworkAclAssociationId')
aws ec2 replace-network-acl-association --association-id "$CURRENT" --network-acl-id "$ACL" >/dev/null
expect DependencyViolation aws ec2 delete-network-acl --network-acl-id "$ACL"
aws ec2 delete-network-acl-entry --network-acl-id "$ACL" --rule-number 100 --ingress
echo "ok  network ACLs"

# --- Elastic IP and NAT gateway (phase 4, partial) ---
NATSUBNET=$(aws ec2 create-subnet --vpc-id "$VPC" --cidr-block 10.89.3.0/24 --availability-zone eu-west-1a --query Subnet.SubnetId)
NATIGW=$(aws ec2 create-internet-gateway --query InternetGateway.InternetGatewayId)
aws ec2 attach-internet-gateway --internet-gateway-id "$NATIGW" --vpc-id "$VPC"
EIP=$(aws ec2 allocate-address --domain vpc --query AllocationId)
equals "$(aws ec2 describe-subnets --subnet-ids "$NATSUBNET" --query 'Subnets[0].AvailableIpAddressCount')" 251
NAT=$(aws ec2 create-nat-gateway --subnet-id "$NATSUBNET" --allocation-id "$EIP" --tag-specifications 'ResourceType=natgateway,Tags=[{Key=Name,Value=cli}]' --query NatGateway.NatGatewayId)
equals "$(aws ec2 describe-nat-gateways --nat-gateway-ids "$NAT" --query 'NatGateways[0].State')" available
equals "$(aws ec2 describe-subnets --subnet-ids "$NATSUBNET" --query 'Subnets[0].AvailableIpAddressCount')" 250
expect DependencyViolation aws ec2 detach-internet-gateway --internet-gateway-id "$NATIGW" --vpc-id "$VPC"
expect InvalidIPAddress.InUse aws ec2 release-address --allocation-id "$EIP"
NATRTB=$(aws ec2 create-route-table --vpc-id "$VPC" --query RouteTable.RouteTableId)
aws ec2 create-route --route-table-id "$NATRTB" --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$NAT" >/dev/null
equals "$(aws ec2 describe-route-tables --route-table-ids "$NATRTB" --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`].State')" active
aws ec2 delete-nat-gateway --nat-gateway-id "$NAT" >/dev/null
equals "$(aws ec2 describe-route-tables --route-table-ids "$NATRTB" --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`].State')" blackhole
equals "$(aws ec2 describe-subnets --subnet-ids "$NATSUBNET" --query 'Subnets[0].AvailableIpAddressCount')" 251
echo "ok  elastic ip and NAT gateway"

echo done
