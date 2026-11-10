#!/usr/bin/env python3
"""EC2 networking check (phases 2 and 3) with boto3 against the local dev server.

    python3 scripts/verify-ec2/check.py

Uses the default AWS profile (the bootstrap key of db/tokens.json). The endpoint is AWS_ENDPOINT_URL or
http://localhost:3000. botocore parses every response with the real EC2 model, so a wrong element name or
shape fails here even when the simulator's own tests pass. Everything the script creates is deleted again.
"""
import os
import sys

import boto3
from botocore.exceptions import ClientError

ec2 = boto3.client(
    "ec2",
    region_name="eu-west-1",
    endpoint_url=os.environ.get("AWS_ENDPOINT_URL", "http://localhost:3000"),
)


def code_of(fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except ClientError as e:
        return e.response["Error"]["Code"]
    return None


def expect_error(expected, fn, *args, **kwargs):
    got = code_of(fn, *args, **kwargs)
    assert got == expected, f"expected {expected}, got {got}"


def perm(protocol, from_port=None, to_port=None, cidr=None, cidr6=None, group=None, description=None):
    p = {"IpProtocol": protocol}
    if from_port is not None:
        p["FromPort"] = from_port
        p["ToPort"] = to_port
    extra = {"Description": description} if description else {}
    if cidr:
        p["IpRanges"] = [{"CidrIp": cidr, **extra}]
    if cidr6:
        p["Ipv6Ranges"] = [{"CidrIpv6": cidr6, **extra}]
    if group:
        p["UserIdGroupPairs"] = [{"GroupId": group, **extra}]
    return p


def rules(group_id):
    return ec2.describe_security_group_rules(Filters=[{"Name": "group-id", "Values": [group_id]}])["SecurityGroupRules"]


def check_internet_gateways_and_routes(vpc):
    igw = ec2.create_internet_gateway(
        TagSpecifications=[{"ResourceType": "internet-gateway", "Tags": [{"Key": "Name", "Value": "check"}]}]
    )["InternetGateway"]["InternetGatewayId"]
    ec2.attach_internet_gateway(InternetGatewayId=igw, VpcId=vpc)
    expect_error("InvalidInternetGatewayID.AlreadyAttached", ec2.attach_internet_gateway, InternetGatewayId=igw, VpcId=vpc)
    expect_error("DependencyViolation", ec2.delete_internet_gateway, InternetGatewayId=igw)

    subnet = ec2.create_subnet(VpcId=vpc, CidrBlock="10.88.1.0/24", AvailabilityZone="eu-west-1a")["Subnet"]["SubnetId"]
    rtb = ec2.create_route_table(VpcId=vpc)["RouteTable"]["RouteTableId"]
    ec2.create_route(RouteTableId=rtb, DestinationCidrBlock="0.0.0.0/0", GatewayId=igw)
    ec2.replace_route(RouteTableId=rtb, DestinationCidrBlock="0.0.0.0/0", GatewayId=igw)
    assoc = ec2.associate_route_table(RouteTableId=rtb, SubnetId=subnet)["AssociationId"]
    table = ec2.describe_route_tables(RouteTableIds=[rtb])["RouteTables"][0]
    assert {r.get("DestinationCidrBlock") for r in table["Routes"]} == {"10.88.0.0/16", "0.0.0.0/0"}
    assert table["Associations"][0]["SubnetId"] == subnet
    expect_error("DependencyViolation", ec2.delete_route_table, RouteTableId=rtb)

    ec2.disassociate_route_table(AssociationId=assoc)
    ec2.delete_route(RouteTableId=rtb, DestinationCidrBlock="0.0.0.0/0")
    ec2.delete_route_table(RouteTableId=rtb)
    ec2.detach_internet_gateway(InternetGatewayId=igw, VpcId=vpc)
    ec2.delete_internet_gateway(InternetGatewayId=igw)
    ec2.delete_subnet(SubnetId=subnet)
    print("ok  internet gateways and route tables")


def check_security_groups(vpc):
    web = ec2.create_security_group(
        GroupName="check-web", Description="web", VpcId=vpc,
        TagSpecifications=[{"ResourceType": "security-group", "Tags": [{"Key": "Name", "Value": "web"}]}],
    )["GroupId"]
    db = ec2.create_security_group(GroupName="check-db", Description="db", VpcId=vpc)["GroupId"]
    expect_error("InvalidGroup.Duplicate", ec2.create_security_group, GroupName="check-db", Description="x", VpcId=vpc)
    expect_error("InvalidGroup.Reserved", ec2.create_security_group, GroupName="default", Description="x", VpcId=vpc)

    group = ec2.describe_security_groups(GroupIds=[web])["SecurityGroups"][0]
    assert group["IpPermissions"] == [] and group["IpPermissionsEgress"][0]["IpRanges"] == [{"CidrIp": "0.0.0.0/0"}]

    created = ec2.authorize_security_group_ingress(GroupId=db, IpPermissions=[
        perm("tcp", 5432, 5432, group=web, description="from web"),
        perm("tcp", 22, 22, cidr="10.0.0.77/24", description="ssh"),
        perm("icmp", -1, -1, cidr6="::/0"),
        perm("-1", cidr="192.168.0.0/16"),
    ])["SecurityGroupRules"]
    assert len(created) == 4 and created[1]["CidrIpv4"] == "10.0.0.0/24"
    assert created[0]["ReferencedGroupInfo"]["GroupId"] == web
    expect_error("InvalidPermission.Duplicate", ec2.authorize_security_group_ingress, GroupId=db,
                 IpPermissions=[perm("tcp", 22, 22, cidr="10.0.0.0/24")])
    expect_error("InvalidPermission.Malformed", ec2.authorize_security_group_ingress, GroupId=db,
                 IpPermissions=[perm("tcp", 1, 1, cidr="10.0.0.0/33")])
    expect_error("InvalidGroup.NotFound", ec2.authorize_security_group_ingress, GroupId=db,
                 IpPermissions=[perm("tcp", 1, 1, group="sg-0123456789abcdef0")])
    # shorthand parameters
    ec2.authorize_security_group_egress(GroupId=db, IpProtocol="udp", FromPort=53, ToPort=53, CidrIp="10.0.0.2/32")

    by_group = ec2.describe_security_groups(Filters=[{"Name": "ip-permission.group-id", "Values": [web]}])["SecurityGroups"]
    assert [g["GroupId"] for g in by_group] == [db]
    assert len(rules(db)) == 6

    ssh, https = created[1]["SecurityGroupRuleId"], created[0]["SecurityGroupRuleId"]
    ec2.modify_security_group_rules(GroupId=db, SecurityGroupRules=[{
        "SecurityGroupRuleId": ssh,
        "SecurityGroupRule": {"IpProtocol": "tcp", "FromPort": 2222, "ToPort": 2222, "CidrIpv4": "172.16.0.0/12", "Description": "ssh2"},
    }])
    changed = ec2.describe_security_group_rules(SecurityGroupRuleIds=[ssh])["SecurityGroupRules"][0]
    assert changed["FromPort"] == 2222 and changed["CidrIpv4"] == "172.16.0.0/12" and changed["Description"] == "ssh2"
    ec2.update_security_group_rule_descriptions_ingress(
        GroupId=db, SecurityGroupRuleDescriptions=[{"SecurityGroupRuleId": https, "Description": "pg"}])
    assert ec2.describe_security_group_rules(SecurityGroupRuleIds=[https])["SecurityGroupRules"][0]["Description"] == "pg"

    # referenced by another group's rule, and the default group
    expect_error("DependencyViolation", ec2.delete_security_group, GroupId=web)
    default = ec2.describe_security_groups(Filters=[
        {"Name": "vpc-id", "Values": [vpc]}, {"Name": "group-name", "Values": ["default"]}])["SecurityGroups"][0]["GroupId"]
    expect_error("CannotDelete", ec2.delete_security_group, GroupId=default)
    expect_error("DependencyViolation", ec2.delete_vpc, VpcId=vpc)

    revoked = ec2.revoke_security_group_ingress(GroupId=db, SecurityGroupRuleIds=[https])
    assert [r["SecurityGroupRuleId"] for r in revoked["RevokedSecurityGroupRules"]] == [https]
    expect_error("InvalidPermission.NotFound", ec2.revoke_security_group_ingress, GroupId=db,
                 IpPermissions=[perm("tcp", 9, 9, cidr="10.0.0.0/8")])
    ec2.revoke_security_group_ingress(GroupId=db, IpPermissions=[perm("tcp", 2222, 2222, cidr="172.16.0.0/12")])
    ec2.revoke_security_group_egress(GroupId=db, IpPermissions=[perm("-1", cidr="0.0.0.0/0")])

    ec2.delete_security_group(GroupId=web)
    remaining = [r["SecurityGroupRuleId"] for r in rules(db)]
    ec2.delete_security_group(GroupId=db)
    assert rules(db) == []
    for rule_id in remaining:
        expect_error("InvalidSecurityGroupRuleId.NotFound", ec2.describe_security_group_rules, SecurityGroupRuleIds=[rule_id])
    print("ok  security groups")


def check_network_acls(vpc):
    acl = ec2.create_network_acl(
        VpcId=vpc, TagSpecifications=[{"ResourceType": "network-acl", "Tags": [{"Key": "Name", "Value": "check"}]}]
    )["NetworkAcl"]["NetworkAclId"]
    entries = ec2.describe_network_acls(NetworkAclIds=[acl])["NetworkAcls"][0]["Entries"]
    assert [(e["Egress"], e["RuleNumber"], e["RuleAction"]) for e in entries] == [(True, 32767, "deny"), (False, 32767, "deny")]

    ec2.create_network_acl_entry(NetworkAclId=acl, RuleNumber=200, Protocol="tcp", RuleAction="allow", Egress=False,
                                 CidrBlock="10.1.2.3/16", PortRange={"From": 443, "To": 443})
    ec2.create_network_acl_entry(NetworkAclId=acl, RuleNumber=100, Protocol="icmp", RuleAction="deny", Egress=False,
                                 CidrBlock="0.0.0.0/0", IcmpTypeCode={"Type": 8, "Code": -1})
    ec2.create_network_acl_entry(NetworkAclId=acl, RuleNumber=100, Protocol="-1", RuleAction="allow", Egress=True,
                                 Ipv6CidrBlock="::/0")
    expect_error("NetworkAclEntryAlreadyExists", ec2.create_network_acl_entry, NetworkAclId=acl, RuleNumber=200,
                 Protocol="-1", RuleAction="allow", Egress=False, CidrBlock="10.0.0.0/8")
    expect_error("InvalidParameterValue", ec2.create_network_acl_entry, NetworkAclId=acl, RuleNumber=32767,
                 Protocol="-1", RuleAction="allow", Egress=False, CidrBlock="10.0.0.0/8")
    ec2.replace_network_acl_entry(NetworkAclId=acl, RuleNumber=200, Protocol="tcp", RuleAction="deny", Egress=False,
                                  CidrBlock="10.2.0.0/16", PortRange={"From": 8443, "To": 8443})
    got = {(e["Egress"], e["RuleNumber"]): e for e in ec2.describe_network_acls(NetworkAclIds=[acl])["NetworkAcls"][0]["Entries"]}
    assert got[(False, 200)]["CidrBlock"] == "10.2.0.0/16" and got[(False, 200)]["RuleAction"] == "deny"
    assert got[(False, 100)]["IcmpTypeCode"] == {"Type": 8, "Code": -1}
    assert got[(True, 100)]["Ipv6CidrBlock"] == "::/0"
    ec2.delete_network_acl_entry(NetworkAclId=acl, RuleNumber=200, Egress=False)
    expect_error("InvalidNetworkAclEntry.NotFound", ec2.delete_network_acl_entry, NetworkAclId=acl, RuleNumber=200, Egress=False)

    subnet = ec2.create_subnet(VpcId=vpc, CidrBlock="10.88.2.0/24", AvailabilityZone="eu-west-1b")["Subnet"]["SubnetId"]
    current = ec2.describe_network_acls(Filters=[{"Name": "association.subnet-id", "Values": [subnet]}])["NetworkAcls"][0]
    assoc = next(a["NetworkAclAssociationId"] for a in current["Associations"] if a["SubnetId"] == subnet)
    assert current["IsDefault"]
    moved = ec2.replace_network_acl_association(AssociationId=assoc, NetworkAclId=acl)["NewAssociationId"]
    assert moved != assoc
    expect_error("DependencyViolation", ec2.delete_network_acl, NetworkAclId=acl)
    expect_error("InvalidParameterValue", ec2.delete_network_acl, NetworkAclId=current["NetworkAclId"])
    expect_error("DependencyViolation", ec2.delete_vpc, VpcId=vpc)
    ec2.replace_network_acl_association(AssociationId=moved, NetworkAclId=current["NetworkAclId"])
    ec2.delete_network_acl(NetworkAclId=acl)
    ec2.delete_subnet(SubnetId=subnet)
    print("ok  network ACLs")


def check_nat_gateways(vpc):
    """Elastic IP and NAT gateway (phase 4, partial): lifetime, derived route state, derived subnet address count."""
    subnet = ec2.create_subnet(VpcId=vpc, CidrBlock="10.88.3.0/24", AvailabilityZone="eu-west-1a")["Subnet"]["SubnetId"]
    igw = ec2.create_internet_gateway()["InternetGateway"]["InternetGatewayId"]
    ec2.attach_internet_gateway(InternetGatewayId=igw, VpcId=vpc)
    eip = ec2.allocate_address(Domain="vpc", TagSpecifications=[{"ResourceType": "elastic-ip", "Tags": [{"Key": "Name", "Value": "check"}]}])
    assert eip["PublicIp"].startswith(("198.18.", "198.19."))

    def free(subnet_id):
        return ec2.describe_subnets(SubnetIds=[subnet_id])["Subnets"][0]["AvailableIpAddressCount"]

    assert free(subnet) == 251
    nat = ec2.create_nat_gateway(SubnetId=subnet, AllocationId=eip["AllocationId"],
                                 TagSpecifications=[{"ResourceType": "natgateway", "Tags": [{"Key": "Name", "Value": "check"}]}])["NatGateway"]
    nat_id = nat["NatGatewayId"]
    assert nat["State"] == "available" and nat["NatGatewayAddresses"][0]["PublicIp"] == eip["PublicIp"]
    eni_id = nat["NatGatewayAddresses"][0]["NetworkInterfaceId"]
    eni = ec2.describe_network_interfaces(NetworkInterfaceIds=[eni_id])["NetworkInterfaces"][0]
    assert eni["RequesterManaged"] and eni["InterfaceType"] == "nat_gateway" and eni["Description"] == f"Interface for NAT Gateway {nat_id}"
    assert free(subnet) == 250
    assert ec2.describe_addresses(AllocationIds=[eip["AllocationId"]])["Addresses"][0]["NetworkInterfaceId"] == eni_id

    expect_error("DependencyViolation", ec2.delete_subnet, SubnetId=subnet)
    expect_error("DependencyViolation", ec2.detach_internet_gateway, InternetGatewayId=igw, VpcId=vpc)
    expect_error("InvalidIPAddress.InUse", ec2.release_address, AllocationId=eip["AllocationId"])
    expect_error("NatGatewayNotFound", ec2.describe_nat_gateways, NatGatewayIds=["nat-0123456789abcdef0"])

    rtb = ec2.create_route_table(VpcId=vpc)["RouteTable"]["RouteTableId"]
    ec2.create_route(RouteTableId=rtb, DestinationCidrBlock="0.0.0.0/0", NatGatewayId=nat_id)

    def route_state():
        routes = ec2.describe_route_tables(RouteTableIds=[rtb])["RouteTables"][0]["Routes"]
        return next(r["State"] for r in routes if r.get("DestinationCidrBlock") == "0.0.0.0/0")

    assert route_state() == "active"
    ec2.delete_nat_gateway(NatGatewayId=nat_id)
    assert ec2.describe_nat_gateways(NatGatewayIds=[nat_id])["NatGateways"][0]["State"] == "deleted"
    assert route_state() == "blackhole"          # derived: nobody changed the route
    assert free(subnet) == 251
    expect_error("InvalidAssociationID.NotFound", ec2.disassociate_address, AssociationId=nat["NatGatewayAddresses"][0]["AssociationId"])
    ec2.delete_route(RouteTableId=rtb, DestinationCidrBlock="0.0.0.0/0")
    ec2.delete_route_table(RouteTableId=rtb)
    ec2.release_address(AllocationId=eip["AllocationId"], NetworkBorderGroup="eu-west-1")
    ec2.detach_internet_gateway(InternetGatewayId=igw, VpcId=vpc)
    ec2.delete_internet_gateway(InternetGatewayId=igw)
    ec2.delete_subnet(SubnetId=subnet)
    print("ok  elastic ip and NAT gateway")


def main():
    vpc = ec2.create_vpc(CidrBlock="10.88.0.0/16")["Vpc"]["VpcId"]
    try:
        check_internet_gateways_and_routes(vpc)
        check_security_groups(vpc)
        check_network_acls(vpc)
        check_nat_gateways(vpc)
    finally:
        # custom groups and ACLs are left behind only when a check failed half way
        for group in ec2.describe_security_groups(Filters=[{"Name": "vpc-id", "Values": [vpc]}])["SecurityGroups"]:
            if group["GroupName"] != "default":
                for rule in rules(group["GroupId"]):
                    if rule.get("ReferencedGroupInfo"):
                        ec2.revoke_security_group_ingress(GroupId=group["GroupId"], SecurityGroupRuleIds=[rule["SecurityGroupRuleId"]])
        for group in ec2.describe_security_groups(Filters=[{"Name": "vpc-id", "Values": [vpc]}])["SecurityGroups"]:
            if group["GroupName"] != "default":
                ec2.delete_security_group(GroupId=group["GroupId"])
        for acl in ec2.describe_network_acls(Filters=[{"Name": "vpc-id", "Values": [vpc]}])["NetworkAcls"]:
            if not acl["IsDefault"]:
                for assoc in acl["Associations"]:
                    default = next(a for a in ec2.describe_network_acls(Filters=[{"Name": "vpc-id", "Values": [vpc]}, {"Name": "default", "Values": ["true"]}])["NetworkAcls"])
                    ec2.replace_network_acl_association(AssociationId=assoc["NetworkAclAssociationId"], NetworkAclId=default["NetworkAclId"])
                ec2.delete_network_acl(NetworkAclId=acl["NetworkAclId"])
        for subnet in ec2.describe_subnets(Filters=[{"Name": "vpc-id", "Values": [vpc]}])["Subnets"]:
            ec2.delete_subnet(SubnetId=subnet["SubnetId"])
        ec2.delete_vpc(VpcId=vpc)
    print("done")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(f"FAILED: {e}")
        sys.exit(1)
