import { AwsError } from "../common"
import { contains, overlaps, parseCidr } from "../db/ec2/cidr"
import { availabilityZones } from "../db/ec2/regions"
import { availableAddressCount } from "../db/ec2/interfaces"
import { createDefaultSubnet, createSubnet, defaultVpc, type Resource } from "../db/ec2/state"
import { QUOTAS, quota } from "../quotas"
import { describe } from "./describe"
import { KINDS, find, invalidValue, missing, tagsFromSpecifications, type Op } from "./request"
import { parseBlock, unsupportedIpv6 } from "./vpc"

function resolveZone(region: string, name?: string, id?: string) {
  const zones = availabilityZones(region)
  if (!name && !id) {
    return zones[0]
  }
  const zone = zones.find(z => (!name || z.name === name) && (!id || z.id === id))
  if (!zone) {
    if (name) {
      invalidValue(`Value (${name}) for parameter availabilityZone is invalid. Subnets can currently only be created in the following availability zones: ${zones.map(z => z.name).join(', ')}.`)
    }
    invalidValue(`Invalid availability zone id: ${id}`)
  }
  return zone
}

export const createSubnetOp: Op = (state, { scope, params }) => {
  const vpc = find(state.vpcs, params.VpcId, KINDS.vpc)
  if (params.Ipv6CidrBlock || params.Ipv6Native || params.Ipv6IpamPoolId) {
    unsupportedIpv6()
  }
  if (!params.CidrBlock) {
    missing('CidrBlock')
  }
  const zone = resolveZone(scope.region, params.AvailabilityZone, params.AvailabilityZoneId)
  const cidr = parseBlock(params.CidrBlock, 'cidrBlock', 'InvalidSubnet.Range')
  const vpcBlocks = vpc.CidrBlockAssociationSet.map((a: any) => parseCidr(a.CidrBlock)!)
  if (!vpcBlocks.some((block: any) => contains(block, cidr))) {
    throw new AwsError('InvalidSubnet.Range', `The CIDR '${params.CidrBlock}' is invalid.`)
  }
  const siblings = Object.values(state.subnets).filter(s => s.VpcId === vpc.VpcId)
  if (siblings.some(s => overlaps(parseCidr(s.CidrBlock)!, cidr))) {
    throw new AwsError('InvalidSubnet.Conflict', `The CIDR '${params.CidrBlock}' conflicts with another subnet`)
  }
  if (siblings.length >= quota(scope, QUOTAS.subnetsPerVpc)) {
    throw new AwsError('SubnetLimitExceeded', 'You have reached the limit on the number of subnets that you can create')
  }
  const tags = tagsFromSpecifications(params.TagSpecifications, 'subnet')
  return { Subnet: createSubnet(state, scope, { vpcId: vpc.VpcId, cidr: params.CidrBlock, zone, tags }) }
}

export const deleteSubnetOp: Op = (state, { params }) => {
  const subnet = find(state.subnets, params.SubnetId, KINDS.subnet)
  if (Object.values(state.networkInterfaces).some(eni => eni.SubnetId === subnet.SubnetId)) {
    throw new AwsError('DependencyViolation', `The subnet '${subnet.SubnetId}' has dependencies and cannot be deleted.`)
  }
  delete state.subnets[subnet.SubnetId]
  // explicit route table and network ACL associations go with the subnet
  for (const acl of Object.values(state.networkAcls)) {
    acl.Associations = acl.Associations.filter((a: any) => a.SubnetId !== subnet.SubnetId)
  }
  for (const rt of Object.values(state.routeTables)) {
    rt.Associations = rt.Associations.filter((a: any) => a.SubnetId !== subnet.SubnetId)
  }
}

export const describeSubnetsOp: Op = (state, { params }) => {
  const dns = (s: any) => s.PrivateDnsNameOptionsOnLaunch
  const ipv6 = (s: any) => s.Ipv6CidrBlockAssociationSet as any[]
  const { items, nextToken } = describe({
    // free addresses follow the interfaces in the subnet, so the count is derived, not stored
    items: Object.values(state.subnets).map((s): Resource => ({ ...s, AvailableIpAddressCount: availableAddressCount(state, s) })),
    idOf: s => s.SubnetId,
    ids: params.SubnetIds,
    kind: KINDS.subnet,
    filters: params.Filters,
    maxResults: params.MaxResults,
    nextToken: params.NextToken,
    filterFns: {
      'availability-zone': s => s.AvailabilityZone,
      availabilityZone: s => s.AvailabilityZone,
      'availability-zone-id': s => s.AvailabilityZoneId,
      availabilityZoneId: s => s.AvailabilityZoneId,
      'available-ip-address-count': s => s.AvailableIpAddressCount,
      'cidr-block': s => s.CidrBlock,
      cidr: s => s.CidrBlock,
      cidrBlock: s => s.CidrBlock,
      'customer-owned-ipv4-pool': () => [],
      'default-for-az': s => s.DefaultForAz,
      defaultForAz: s => s.DefaultForAz,
      'enable-dns64': s => s.EnableDns64,
      'enable-lni-at-device-index': () => [],
      'ipv6-cidr-block-association.ipv6-cidr-block': s => ipv6(s).map(a => a.Ipv6CidrBlock),
      'ipv6-cidr-block-association.association-id': s => ipv6(s).map(a => a.AssociationId),
      'ipv6-cidr-block-association.state': s => ipv6(s).map(a => a.Ipv6CidrBlockState?.State),
      'ipv6-native': s => s.Ipv6Native,
      'map-customer-owned-ip-on-launch': s => s.MapCustomerOwnedIpOnLaunch,
      'map-public-ip-on-launch': s => s.MapPublicIpOnLaunch,
      'outpost-arn': () => [],
      'owner-id': s => s.OwnerId,
      'private-dns-name-options-on-launch.hostname-type': s => dns(s).HostnameType,
      'private-dns-name-options-on-launch.enable-resource-name-dns-a-record': s => dns(s).EnableResourceNameDnsARecord,
      'private-dns-name-options-on-launch.enable-resource-name-dns-aaaa-record': s => dns(s).EnableResourceNameDnsAAAARecord,
      state: s => s.State,
      'subnet-arn': s => s.SubnetArn,
      'subnet-id': s => s.SubnetId,
      'vpc-id': s => s.VpcId,
    },
  })
  return { Subnets: items, NextToken: nextToken }
}

const BOOLEAN_ATTRIBUTES: Record<string, (subnet: any, value: boolean) => void> = {
  MapPublicIpOnLaunch: (s, v) => { s.MapPublicIpOnLaunch = v },
  AssignIpv6AddressOnCreation: (s, v) => { s.AssignIpv6AddressOnCreation = v },
  EnableDns64: (s, v) => { s.EnableDns64 = v },
  EnableResourceNameDnsARecordOnLaunch: (s, v) => { s.PrivateDnsNameOptionsOnLaunch.EnableResourceNameDnsARecord = v },
  EnableResourceNameDnsAAAARecordOnLaunch: (s, v) => { s.PrivateDnsNameOptionsOnLaunch.EnableResourceNameDnsAAAARecord = v },
}

export const modifySubnetAttributeOp: Op = (state, { params }) => {
  const subnet = find(state.subnets, params.SubnetId, KINDS.subnet)
  const booleans = Object.keys(BOOLEAN_ATTRIBUTES).filter(name => params[name] !== undefined)
  const hostnameType = params.PrivateDnsHostnameTypeOnLaunch
  if (booleans.length + (hostnameType !== undefined ? 1 : 0) !== 1) {
    throw new AwsError('InvalidParameterCombination', 'Exactly one attribute can be modified per request.')
  }
  if (hostnameType !== undefined) {
    subnet.PrivateDnsNameOptionsOnLaunch.HostnameType = hostnameType
  } else {
    BOOLEAN_ATTRIBUTES[booleans[0]](subnet, Boolean(params[booleans[0]].Value))
  }
}

export const createDefaultSubnetOp: Op = (state, { scope, params }) => {
  const vpc = defaultVpc(state)
  if (!vpc) {
    throw new AwsError('DefaultVpcDoesNotExist', 'No default VPC exists for this account in this region.')
  }
  const zone = resolveZone(scope.region, params.AvailabilityZone)
  if (Object.values(state.subnets).some(s => s.VpcId === vpc.VpcId && s.AvailabilityZone === zone.name && s.DefaultForAz)) {
    throw new AwsError('DefaultSubnetAlreadyExistsInAvailabilityZone', `A Default Subnet already exists in Availability Zone '${zone.name}'.`)
  }
  return { Subnet: createDefaultSubnet(state, scope, vpc.VpcId, zone) }
}
