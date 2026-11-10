#!/usr/bin/env python3
"""Build the network of the walking-skeleton scenario step by step and print what the simulator says at each step.

    python3 scripts/scenario/network.py          # build, print the traces of A, B, C, D; leave the VPC for inspection
    python3 scripts/scenario/network.py --until B  # stop after variant A, B, C or D and leave the VPC in that state
    python3 scripts/scenario/network.py --clean  # remove it again

A function `orders-fn` in a private subnet calls sts (docs/walking-skeleton.md). Each variant changes one thing:
  A  the private subnet only has the local route          -> no route
  B  0.0.0.0/0 -> NAT gateway in a public subnet          -> reached, source address is the NAT's Elastic IP
  C  as B, the security group only allows tcp/80 out      -> security group blocks
  D  as B again, then the NAT gateway is deleted          -> the route is a blackhole
The VPC is left in state D, with the traces above printed; look at it further with scripts/reach.py (subnets and groups
are named `skeleton-*`). Uses the default AWS profile and endpoint, like scripts/verify-ec2/check.py.
"""
import os
import subprocess
import sys

import boto3
from botocore.exceptions import ClientError

ENDPOINT = os.environ.get('AWS_ENDPOINT_URL', 'http://localhost:3000')
ec2 = boto3.client('ec2', endpoint_url=ENDPOINT)
if not ec2.meta.region_name:
    ec2 = boto3.client('ec2', region_name='eu-west-1', endpoint_url=ENDPOINT)
REGION = ec2.meta.region_name
HOST = f'sts.{REGION}.amazonaws.com'
REACH = os.path.join(os.path.dirname(__file__), '..', 'reach.py')
NAME = 'skeleton'
UNTIL = sys.argv[sys.argv.index('--until') + 1] if '--until' in sys.argv else None


def tagged(kind, name):
    return [{'ResourceType': kind, 'Tags': [{'Key': 'Name', 'Value': name}]}]


def find_vpc():
    found = ec2.describe_vpcs(Filters=[{'Name': 'tag:Name', 'Values': [NAME]}])['Vpcs']
    return found[0]['VpcId'] if found else None


def clean():
    # a function in the VPC owns an interface in the subnet; AWS refuses to delete the subnet before it is gone
    try:
        boto3.client('lambda', region_name=REGION, endpoint_url=ENDPOINT).delete_function(FunctionName='orders-fn')
    except ClientError as error:
        if error.response['Error']['Code'] != 'ResourceNotFoundException':
            raise
    vpc = find_vpc()
    for nat in ec2.describe_nat_gateways(Filter=[{'Name': 'tag:Name', 'Values': [f'{NAME}-nat']}])['NatGateways']:
        if nat['State'] != 'deleted':
            ec2.delete_nat_gateway(NatGatewayId=nat['NatGatewayId'])
    for eip in ec2.describe_addresses(Filters=[{'Name': 'tag:Name', 'Values': [f'{NAME}-eip']}])['Addresses']:
        ec2.release_address(AllocationId=eip['AllocationId'])
    if not vpc:
        return
    for table in ec2.describe_route_tables(Filters=[{'Name': 'vpc-id', 'Values': [vpc]}])['RouteTables']:
        for assoc in table['Associations']:
            if not assoc.get('Main'):
                ec2.disassociate_route_table(AssociationId=assoc['RouteTableAssociationId'])
        if not any(a.get('Main') for a in table['Associations']):
            ec2.delete_route_table(RouteTableId=table['RouteTableId'])
    for igw in ec2.describe_internet_gateways(Filters=[{'Name': 'attachment.vpc-id', 'Values': [vpc]}])['InternetGateways']:
        ec2.detach_internet_gateway(InternetGatewayId=igw['InternetGatewayId'], VpcId=vpc)
        ec2.delete_internet_gateway(InternetGatewayId=igw['InternetGatewayId'])
    for subnet in ec2.describe_subnets(Filters=[{'Name': 'vpc-id', 'Values': [vpc]}])['Subnets']:
        ec2.delete_subnet(SubnetId=subnet['SubnetId'])
    for group in ec2.describe_security_groups(Filters=[{'Name': 'vpc-id', 'Values': [vpc]}])['SecurityGroups']:
        if group['GroupName'] != 'default':
            ec2.delete_security_group(GroupId=group['GroupId'])
    ec2.delete_vpc(VpcId=vpc)


def show(title):
    print(f'\n{"=" * 100}\n{title}\n{"=" * 100}')
    sys.stdout.flush()
    subprocess.run([sys.executable, REACH, '--region', REGION, '--subnet', f'{NAME}-private', '--sg', f'{NAME}-fn', HOST])
    if UNTIL and title.startswith(UNTIL + ':'):
        raise Done()


class Done(Exception):
    pass


def build():
    vpc = ec2.create_vpc(CidrBlock='10.0.0.0/16', TagSpecifications=tagged('vpc', NAME))['Vpc']['VpcId']
    zone = ec2.describe_availability_zones()['AvailabilityZones'][0]['ZoneName']
    public = ec2.create_subnet(VpcId=vpc, CidrBlock='10.0.1.0/24', AvailabilityZone=zone, TagSpecifications=tagged('subnet', f'{NAME}-public'))['Subnet']['SubnetId']
    private = ec2.create_subnet(VpcId=vpc, CidrBlock='10.0.2.0/24', AvailabilityZone=zone, TagSpecifications=tagged('subnet', f'{NAME}-private'))['Subnet']['SubnetId']
    igw = ec2.create_internet_gateway(TagSpecifications=tagged('internet-gateway', NAME))['InternetGateway']['InternetGatewayId']
    ec2.attach_internet_gateway(InternetGatewayId=igw, VpcId=vpc)
    public_table = ec2.create_route_table(VpcId=vpc, TagSpecifications=tagged('route-table', f'{NAME}-public'))['RouteTable']['RouteTableId']
    ec2.create_route(RouteTableId=public_table, DestinationCidrBlock='0.0.0.0/0', GatewayId=igw)
    ec2.associate_route_table(RouteTableId=public_table, SubnetId=public)
    group = ec2.create_security_group(GroupName=f'{NAME}-fn', Description='the function', VpcId=vpc, TagSpecifications=tagged('security-group', f'{NAME}-fn'))['GroupId']

    show('A: the private subnet only has the local route')

    eip = ec2.allocate_address(Domain='vpc', TagSpecifications=tagged('elastic-ip', f'{NAME}-eip'))['AllocationId']
    nat = ec2.create_nat_gateway(SubnetId=public, AllocationId=eip, TagSpecifications=tagged('natgateway', f'{NAME}-nat'))['NatGateway']['NatGatewayId']
    private_table = ec2.create_route_table(VpcId=vpc, TagSpecifications=tagged('route-table', f'{NAME}-private'))['RouteTable']['RouteTableId']
    ec2.create_route(RouteTableId=private_table, DestinationCidrBlock='0.0.0.0/0', NatGatewayId=nat)
    ec2.associate_route_table(RouteTableId=private_table, SubnetId=private)
    show('B: 0.0.0.0/0 -> the NAT gateway in the public subnet')

    everything = [{'IpProtocol': '-1', 'IpRanges': [{'CidrIp': '0.0.0.0/0'}]}]
    ec2.revoke_security_group_egress(GroupId=group, IpPermissions=everything)
    ec2.authorize_security_group_egress(GroupId=group, IpPermissions=[{'IpProtocol': 'tcp', 'FromPort': 80, 'ToPort': 80, 'IpRanges': [{'CidrIp': '0.0.0.0/0'}]}])
    show('C: the security group of the function only allows tcp/80 out')

    ec2.authorize_security_group_egress(GroupId=group, IpPermissions=everything)
    show('B again: egress restored')

    ec2.delete_nat_gateway(NatGatewayId=nat)
    show('D: the NAT gateway was deleted')


if __name__ == '__main__':
    try:
        clean()
        if '--clean' not in sys.argv:
            build()
    except Done:
        pass
    except ClientError as error:
        sys.exit(f'{error.response["Error"]["Code"]}: {error.response["Error"]["Message"]}')
