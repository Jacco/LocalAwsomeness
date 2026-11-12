import { AwsError } from "../common"
import { contains, isNormalized, overlaps, parseCidr, type Cidr } from "../data/ec2/cidr"
import { newId } from "../data/ec2/ids"
import { createDefaultVpc, createVpc, defaultVpc, type Resource } from "../data/ec2/state"
import { QUOTAS, quota } from "../quotas"
import { describe } from "./describe"
import { KINDS, find, invalidValue, missing, tagsFromSpecifications, type Op } from "./request"

export const MIN_PREFIX = 16
export const MAX_PREFIX = 28

export function unsupportedIpv6(): never {
  throw new AwsError('UnsupportedOperation', 'IPv6 is not supported by this service.')
}

// Parses a user supplied block; `rangeError` is the error code for a valid CIDR outside the /16 to /28 range.
export function parseBlock(text: string, parameter: string, rangeError: string): Cidr {
  const cidr = parseCidr(text)
  if (!cidr || !isNormalized(cidr)) {
    invalidValue(`Value (${text}) for parameter ${parameter} is invalid. This is not a valid CIDR block.`)
  }
  if (cidr.prefix < MIN_PREFIX || cidr.prefix > MAX_PREFIX) {
    throw new AwsError(rangeError, `The CIDR '${text}' is invalid.`)
  }
  return cidr
}

export const createVpcOp: Op = (state, { scope, params }) => {
  if (params.AmazonProvidedIpv6CidrBlock || params.Ipv6CidrBlock || params.Ipv6Pool || params.Ipv6IpamPoolId) {
    unsupportedIpv6()
  }
  if (!params.CidrBlock) {
    missing('CidrBlock')
  }
  parseBlock(params.CidrBlock, 'cidrBlock', 'InvalidVpc.Range')
  if (Object.keys(state.vpcs).length >= quota(scope, QUOTAS.vpcsPerRegion)) {
    throw new AwsError('VpcLimitExceeded', 'The maximum number of VPCs has been reached.')
  }
  const tags = tagsFromSpecifications(params.TagSpecifications, 'vpc')
  return { Vpc: createVpc(state, scope, { cidr: params.CidrBlock, tenancy: params.InstanceTenancy, tags }) }
}

export const deleteVpcOp: Op = (state, { params }) => {
  const vpc = find(state.vpcs, params.VpcId, KINDS.vpc)
  const inVpc = (r: Resource) => r.VpcId === vpc.VpcId
  const attached = Object.values(state.internetGateways).some(igw => igw.Attachments.some((a: { VpcId: string }) => a.VpcId === vpc.VpcId))
  const customRouteTables = Object.values(state.routeTables).some(rt => inVpc(rt) && !rt.Associations.some((a: { Main?: boolean }) => a.Main))
  const customAcls = Object.values(state.networkAcls).some(acl => inVpc(acl) && !acl.IsDefault)
  const customGroups = Object.values(state.securityGroups).some(sg => inVpc(sg) && sg.GroupName !== 'default')
  const interfaces = Object.values(state.networkInterfaces).some(inVpc)
  if (Object.values(state.subnets).some(inVpc) || attached || customRouteTables || customAcls || customGroups || interfaces) {
    throw new AwsError('DependencyViolation', `The vpc '${vpc.VpcId}' has dependencies and cannot be deleted.`)
  }
  // The main route table, default network ACL and default security group go with the VPC.
  const groupIds = Object.values(state.securityGroups).filter(inVpc).map(sg => sg.GroupId)
  for (const rule of Object.values(state.securityGroupRules)) {
    if (groupIds.includes(rule.GroupId)) {
      delete state.securityGroupRules[rule.SecurityGroupRuleId]
    }
  }
  for (const collection of [state.routeTables, state.networkAcls, state.securityGroups]) {
    for (const [id, resource] of Object.entries(collection)) {
      if (inVpc(resource)) {
        delete collection[id]
      }
    }
  }
  delete state.vpcAttributes[vpc.VpcId]
  delete state.vpcs[vpc.VpcId]
}

export const describeVpcsOp: Op = (state, { params }) => {
  const associations = (vpc: any) => vpc.CidrBlockAssociationSet as { AssociationId: string; CidrBlock: string; CidrBlockState: { State: string } }[]
  const { items, nextToken } = describe({
    items: Object.values(state.vpcs),
    idOf: vpc => vpc.VpcId,
    ids: params.VpcIds,
    kind: KINDS.vpc,
    filters: params.Filters,
    maxResults: params.MaxResults,
    nextToken: params.NextToken,
    filterFns: {
      cidr: vpc => vpc.CidrBlock,
      'cidr-block': vpc => vpc.CidrBlock,
      'cidr-block-association.cidr-block': vpc => associations(vpc).map(a => a.CidrBlock),
      'cidr-block-association.association-id': vpc => associations(vpc).map(a => a.AssociationId),
      'cidr-block-association.state': vpc => associations(vpc).map(a => a.CidrBlockState.State),
      'dhcp-options-id': vpc => vpc.DhcpOptionsId,
      'ipv6-cidr-block-association.ipv6-cidr-block': () => [],
      'ipv6-cidr-block-association.ipv6-pool': () => [],
      'ipv6-cidr-block-association.association-id': () => [],
      'ipv6-cidr-block-association.state': () => [],
      'is-default': vpc => vpc.IsDefault,
      isDefault: vpc => vpc.IsDefault, // legacy name, still sent by the Terraform provider
      'owner-id': vpc => vpc.OwnerId,
      state: vpc => vpc.State,
      'vpc-id': vpc => vpc.VpcId,
    },
  })
  return { Vpcs: items, NextToken: nextToken }
}

const VPC_ATTRIBUTES = {
  EnableDnsSupport: 'enableDnsSupport',
  EnableDnsHostnames: 'enableDnsHostnames',
  EnableNetworkAddressUsageMetrics: 'enableNetworkAddressUsageMetrics',
} as const

export const modifyVpcAttributeOp: Op = (state, { params }) => {
  const vpc = find(state.vpcs, params.VpcId, KINDS.vpc)
  const given = Object.keys(VPC_ATTRIBUTES).filter(name => params[name] !== undefined)
  if (given.length === 0) {
    throw new AwsError('InvalidParameterCombination', 'No modifications were requested.')
  }
  if (given.length > 1) {
    throw new AwsError('InvalidParameterCombination', 'Fields for multiple attribute types specified: ' + given.map(g => g[0].toLowerCase() + g.slice(1)).join(', '))
  }
  const name = given[0] as keyof typeof VPC_ATTRIBUTES
  const attributes = state.vpcAttributes[vpc.VpcId]
  const value = Boolean(params[name].Value)
  if (name === 'EnableDnsHostnames' && value && !attributes.enableDnsSupport) {
    throw new AwsError('InvalidParameterCombination', 'You cannot enable DNS hostnames when DNS support is disabled.')
  }
  attributes[VPC_ATTRIBUTES[name]] = value
}

export const describeVpcAttributeOp: Op = (state, { params }) => {
  const vpc = find(state.vpcs, params.VpcId, KINDS.vpc)
  const attribute = Object.entries(VPC_ATTRIBUTES).find(([, wire]) => wire === params.Attribute)
  if (!attribute) {
    missing('Attribute')
  }
  return { VpcId: vpc.VpcId, [attribute[0]]: { Value: state.vpcAttributes[vpc.VpcId][attribute[1]] } }
}

export const associateVpcCidrBlockOp: Op = (state, { scope, params }) => {
  const vpc = find(state.vpcs, params.VpcId, KINDS.vpc)
  if (params.AmazonProvidedIpv6CidrBlock || params.Ipv6CidrBlock || params.Ipv6Pool || params.Ipv6IpamPoolId) {
    unsupportedIpv6()
  }
  if (!params.CidrBlock) {
    missing('CidrBlock')
  }
  const cidr = parseBlock(params.CidrBlock, 'cidrBlock', 'InvalidVpc.Range')
  const current = vpc.CidrBlockAssociationSet.filter((a: any) => a.CidrBlockState.State === 'associated')
  if (current.length >= quota(scope, QUOTAS.ipv4CidrBlocksPerVpc)) {
    throw new AwsError('CidrLimitExceeded', `This network '${vpc.VpcId}' has met its maximum number of allowed CIDRs.`)
  }
  if (current.some((a: any) => overlaps(parseCidr(a.CidrBlock)!, cidr))) {
    throw new AwsError('InvalidVpc.Range', `The CIDR '${params.CidrBlock}' conflicts with another CIDR block associated with this VPC.`)
  }
  const association = { AssociationId: newId('vpc-cidr-assoc'), CidrBlock: params.CidrBlock, CidrBlockState: { State: 'associated' } }
  vpc.CidrBlockAssociationSet.push(association)
  for (const rt of Object.values(state.routeTables).filter(rt => rt.VpcId === vpc.VpcId)) {
    rt.Routes.push({ DestinationCidrBlock: params.CidrBlock, GatewayId: 'local', Origin: 'CreateRouteTable', State: 'active' })
  }
  return { VpcId: vpc.VpcId, CidrBlockAssociation: association }
}

export const disassociateVpcCidrBlockOp: Op = (state, { params }) => {
  const id: string = params.AssociationId
  const vpc = Object.values(state.vpcs).find(v => v.CidrBlockAssociationSet.some((a: any) => a.AssociationId === id))
  if (!vpc) {
    throw new AwsError('InvalidVpcCidrBlockAssociationIdError.NotFound', `The vpc CIDR block association ID '${id}' does not exist`)
  }
  const association = vpc.CidrBlockAssociationSet.find((a: any) => a.AssociationId === id)
  if (association.CidrBlock === vpc.CidrBlock) {
    throw new AwsError('OperationNotPermitted', `The vpc CIDR block with association ID ${id} may not be disassociated. It is the primary IPv4 block of the VPC.`)
  }
  const block = parseCidr(association.CidrBlock)!
  if (Object.values(state.subnets).some(s => s.VpcId === vpc.VpcId && contains(block, parseCidr(s.CidrBlock)!))) {
    throw new AwsError('DependencyViolation', `The CIDR block '${association.CidrBlock}' has dependencies and cannot be disassociated.`)
  }
  vpc.CidrBlockAssociationSet = vpc.CidrBlockAssociationSet.filter((a: any) => a.AssociationId !== id)
  for (const rt of Object.values(state.routeTables).filter(rt => rt.VpcId === vpc.VpcId)) {
    rt.Routes = rt.Routes.filter((r: any) => r.DestinationCidrBlock !== association.CidrBlock)
  }
  return { VpcId: vpc.VpcId, CidrBlockAssociation: { ...association, CidrBlockState: { State: 'disassociated' } } }
}

export const createDefaultVpcOp: Op = (state, { scope }) => {
  if (defaultVpc(state)) {
    throw new AwsError('DefaultVpcAlreadyExists', 'A Default VPC already exists for this account in this region.')
  }
  return { Vpc: createDefaultVpc(state, scope) }
}
