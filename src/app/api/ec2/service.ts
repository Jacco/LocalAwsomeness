import { AwsError } from "../common"
import { getRegion } from "../data/account"
import { loadState, saveState } from "../data/ec2/state"
import { defineService, type Handler } from "../registry"
import { describeAccountAttributesOp, describeAvailabilityZonesOp, describeRegionsOp } from "./account"
import {
  describeDhcpOptionsOp, describeInternetGatewaysOp, describeNetworkAclsOp, describeNetworkInterfacesOp, describeRouteTablesOp,
  describeSecurityGroupsOp,
} from "./describes"
import { DRY_RUN_OPERATION, Ec2Protocol } from "./protocol"
import type { Op } from "./request"
import {
  attachInternetGatewayOp, createInternetGatewayOp, deleteInternetGatewayOp, detachInternetGatewayOp,
} from "./internetgateway"
import {
  associateRouteTableOp, createRouteOp, createRouteTableOp, deleteRouteOp, deleteRouteTableOp, disassociateRouteTableOp,
  replaceRouteOp, replaceRouteTableAssociationOp,
} from "./routetable"
import { allocateAddressOp, describeAddressesOp, disassociateAddressOp, releaseAddressOp } from "./address"
import { createNatGatewayOp, deleteNatGatewayOp, describeNatGatewaysOp } from "./natgateway"
import {
  createNetworkAclEntryOp, createNetworkAclOp, deleteNetworkAclEntryOp, deleteNetworkAclOp, replaceNetworkAclAssociationOp,
  replaceNetworkAclEntryOp,
} from "./networkacl"
import {
  authorizeSecurityGroupEgressOp, authorizeSecurityGroupIngressOp, createSecurityGroupOp, deleteSecurityGroupOp,
  describeSecurityGroupRulesOp, modifySecurityGroupRulesOp, revokeSecurityGroupEgressOp, revokeSecurityGroupIngressOp,
  updateSecurityGroupRuleDescriptionsEgressOp, updateSecurityGroupRuleDescriptionsIngressOp,
} from "./securitygroup"
import {
  createDefaultSubnetOp, createSubnetOp, deleteSubnetOp, describeSubnetsOp, modifySubnetAttributeOp,
} from "./subnet"
import { createTagsOp, deleteTagsOp, describeTagsOp } from "./tags"
import {
  associateVpcCidrBlockOp, createDefaultVpcOp, createVpcOp, deleteVpcOp, describeVpcAttributeOp, describeVpcsOp,
  disassociateVpcCidrBlockOp, modifyVpcAttributeOp,
} from "./vpc"
import {
  createVpcEndpointOp, deleteVpcEndpointOp, describeVpcEndpointsOp, modifyVpcEndpointOp,
} from "./vpcendpoint"

// Runs an operation against the caller's state for the request region. DryRun operations do all validation
// and then fail with DryRunOperation instead of persisting.
function operation(op: Op, mutates: boolean): Handler {
  return ctx => {
    const scope = { account: ctx.account, region: ctx.region }
    if (getRegion(scope.account, scope.region) === 'DISABLED') {
      throw new AwsError('AuthFailure', 'AWS was not able to validate the provided access credentials', 401)
    }
    const state = loadState(scope)
    const result = op(state, { scope, principal: ctx.principal, params: ctx.params })
    if (ctx.params.DryRun) {
      throw DRY_RUN_OPERATION()
    }
    if (mutates) {
      saveState(scope, state)
    }
    return result
  }
}

const read = (op: Op) => operation(op, false)
const write = (op: Op) => operation(op, true)

export const ec2 = defineService({
  iamPrefix: 'ec2',
  protocol: new Ec2Protocol(),
  operations: {
    DescribeAccountAttributes: read(describeAccountAttributesOp),
    DescribeRegions: read(describeRegionsOp),
    DescribeAvailabilityZones: read(describeAvailabilityZonesOp),

    CreateTags: write(createTagsOp),
    DeleteTags: write(deleteTagsOp),
    DescribeTags: read(describeTagsOp),

    CreateVpc: write(createVpcOp),
    DeleteVpc: write(deleteVpcOp),
    DescribeVpcs: read(describeVpcsOp),
    ModifyVpcAttribute: write(modifyVpcAttributeOp),
    DescribeVpcAttribute: read(describeVpcAttributeOp),
    AssociateVpcCidrBlock: write(associateVpcCidrBlockOp),
    DisassociateVpcCidrBlock: write(disassociateVpcCidrBlockOp),
    CreateDefaultVpc: write(createDefaultVpcOp),

    CreateSubnet: write(createSubnetOp),
    DeleteSubnet: write(deleteSubnetOp),
    DescribeSubnets: read(describeSubnetsOp),
    ModifySubnetAttribute: write(modifySubnetAttributeOp),
    CreateDefaultSubnet: write(createDefaultSubnetOp),

    CreateInternetGateway: write(createInternetGatewayOp),
    DeleteInternetGateway: write(deleteInternetGatewayOp),
    AttachInternetGateway: write(attachInternetGatewayOp),
    DetachInternetGateway: write(detachInternetGatewayOp),

    CreateRouteTable: write(createRouteTableOp),
    DeleteRouteTable: write(deleteRouteTableOp),
    CreateRoute: write(createRouteOp),
    ReplaceRoute: write(replaceRouteOp),
    DeleteRoute: write(deleteRouteOp),
    AssociateRouteTable: write(associateRouteTableOp),
    DisassociateRouteTable: write(disassociateRouteTableOp),
    ReplaceRouteTableAssociation: write(replaceRouteTableAssociationOp),

    CreateSecurityGroup: write(createSecurityGroupOp),
    DeleteSecurityGroup: write(deleteSecurityGroupOp),
    AuthorizeSecurityGroupIngress: write(authorizeSecurityGroupIngressOp),
    AuthorizeSecurityGroupEgress: write(authorizeSecurityGroupEgressOp),
    RevokeSecurityGroupIngress: write(revokeSecurityGroupIngressOp),
    RevokeSecurityGroupEgress: write(revokeSecurityGroupEgressOp),
    ModifySecurityGroupRules: write(modifySecurityGroupRulesOp),
    UpdateSecurityGroupRuleDescriptionsIngress: write(updateSecurityGroupRuleDescriptionsIngressOp),
    UpdateSecurityGroupRuleDescriptionsEgress: write(updateSecurityGroupRuleDescriptionsEgressOp),
    DescribeSecurityGroupRules: read(describeSecurityGroupRulesOp),

    CreateNetworkAcl: write(createNetworkAclOp),
    DeleteNetworkAcl: write(deleteNetworkAclOp),
    CreateNetworkAclEntry: write(createNetworkAclEntryOp),
    ReplaceNetworkAclEntry: write(replaceNetworkAclEntryOp),
    DeleteNetworkAclEntry: write(deleteNetworkAclEntryOp),
    ReplaceNetworkAclAssociation: write(replaceNetworkAclAssociationOp),

    AllocateAddress: write(allocateAddressOp),
    ReleaseAddress: write(releaseAddressOp),
    DisassociateAddress: write(disassociateAddressOp),
    DescribeAddresses: read(describeAddressesOp),
    CreateNatGateway: write(createNatGatewayOp),
    DeleteNatGateway: write(deleteNatGatewayOp),
    DescribeNatGateways: read(describeNatGatewaysOp),

    DescribeRouteTables: read(describeRouteTablesOp),
    DescribeNetworkAcls: read(describeNetworkAclsOp),
    DescribeSecurityGroups: read(describeSecurityGroupsOp),
    DescribeInternetGateways: read(describeInternetGatewaysOp),
    DescribeDhcpOptions: read(describeDhcpOptionsOp),
    DescribeNetworkInterfaces: read(describeNetworkInterfacesOp),

    CreateVpcEndpoint: write(createVpcEndpointOp),
    DeleteVpcEndpoint: write(deleteVpcEndpointOp),
    DescribeVpcEndpoints: read(describeVpcEndpointsOp),
    ModifyVpcEndpoint: write(modifyVpcEndpointOp),
  },
})
