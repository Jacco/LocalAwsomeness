"""Builds data/aws/ec2-model.json from the botocore EC2 service model.

The simulator generates EC2 request decoding and response XML from these shapes, so the output only
keeps what the protocol layer needs (no documentation). Add operation names to OPERATIONS and re-run
when a new EC2 API is implemented:

    python3 getec2model.py

botocore is Apache-2.0 licensed; the extracted shapes are derived from its service-2.json.
"""
import json
from pathlib import Path

import botocore
from botocore.loaders import Loader

OUTPUT = Path("data/aws/ec2-model.json")

OPERATIONS = [
    # account, regions
    "DescribeAccountAttributes", "DescribeRegions", "DescribeAvailabilityZones",
    # tags
    "CreateTags", "DeleteTags", "DescribeTags",
    # vpc
    "CreateVpc", "DeleteVpc", "DescribeVpcs", "ModifyVpcAttribute", "DescribeVpcAttribute",
    "AssociateVpcCidrBlock", "DisassociateVpcCidrBlock", "CreateDefaultVpc",
    # subnet
    "CreateSubnet", "DeleteSubnet", "DescribeSubnets", "ModifySubnetAttribute", "CreateDefaultSubnet",
    # phase 2: internet gateways and route tables
    "CreateInternetGateway", "DeleteInternetGateway", "AttachInternetGateway", "DetachInternetGateway",
    "CreateRouteTable", "DeleteRouteTable", "CreateRoute", "ReplaceRoute", "DeleteRoute",
    "AssociateRouteTable", "DisassociateRouteTable", "ReplaceRouteTableAssociation",
    # phase 3: security groups and network ACLs
    "CreateSecurityGroup", "DeleteSecurityGroup",
    "AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress",
    "RevokeSecurityGroupIngress", "RevokeSecurityGroupEgress",
    "ModifySecurityGroupRules", "DescribeSecurityGroupRules",
    "UpdateSecurityGroupRuleDescriptionsIngress", "UpdateSecurityGroupRuleDescriptionsEgress",
    "CreateNetworkAcl", "DeleteNetworkAcl", "CreateNetworkAclEntry", "ReplaceNetworkAclEntry",
    "DeleteNetworkAclEntry", "ReplaceNetworkAclAssociation",
    # objects created implicitly with a VPC (read-only for now)
    "DescribeRouteTables", "DescribeNetworkAcls", "DescribeSecurityGroups", "DescribeInternetGateways",
    "DescribeDhcpOptions", "DescribeNetworkInterfaces",
    # phase 4 (partial, scoped by the walking skeleton): Elastic IPs and NAT gateways
    "AllocateAddress", "ReleaseAddress", "DescribeAddresses", "DisassociateAddress",
    "CreateNatGateway", "DeleteNatGateway", "DescribeNatGateways",
]

KEEP = ("type", "members", "member", "key", "value", "required", "enum", "flattened", "locationName", "queryName")


def reachable(shapes, name, seen):
    if name in seen:
        return
    seen.add(name)
    shape = shapes[name]
    for member in shape.get("members", {}).values():
        reachable(shapes, member["shape"], seen)
    for ref in ("member", "key", "value"):
        if ref in shape:
            reachable(shapes, shape[ref]["shape"], seen)


def slim(shape):
    result = {k: v for k, v in shape.items() if k in KEEP}
    if "members" in result:
        result["members"] = {
            name: {k: v for k, v in member.items() if k in ("shape", "locationName", "queryName")}
            for name, member in result["members"].items()
        }
    for ref in ("member", "key", "value"):
        if ref in result:
            result[ref] = {k: v for k, v in result[ref].items() if k in ("shape", "locationName", "queryName")}
    return result


model = Loader().load_service_model("ec2", "service-2")
operations = {}
needed = set()
for name in OPERATIONS:
    op = model["operations"][name]
    operations[name] = {key: op[key]["shape"] for key in ("input", "output") if key in op}
    for shape in operations[name].values():
        reachable(model["shapes"], shape, needed)

output = {
    "_source": f"botocore {botocore.__version__} ec2/{model['metadata']['apiVersion']}/service-2.json (Apache-2.0)",
    "apiVersion": model["metadata"]["apiVersion"],
    "operations": operations,
    "shapes": {name: slim(model["shapes"][name]) for name in sorted(needed)},
}
OUTPUT.write_text(json.dumps(output, separators=(",", ":")))
print(f"{len(operations)} operations, {len(needed)} shapes, {OUTPUT.stat().st_size // 1024} KB")
