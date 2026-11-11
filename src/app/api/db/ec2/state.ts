import { PARTITION, assertValidRegion, enableByDefaultRegions } from "../common"
import * as store from "../store"
import { addressCount, formatCidr, parseCidr } from "./cidr"
import { newId, newResourceId, type ResourceType } from "./ids"
import { availabilityZones, regionDomain } from "./regions"

// Records are stored in the shape the API returns them (member names from the EC2 service model), so
// Describe operations can serialize them directly.

export interface Tag {
  Key: string
  Value: string
}

export interface Resource {
  Tags: Tag[]
  [member: string]: any
}

export interface VpcAttributes {
  enableDnsSupport: boolean
  enableDnsHostnames: boolean
  enableNetworkAddressUsageMetrics: boolean
}

export interface Ec2State {
  defaultDhcpOptionsId: string
  vpcs: Record<string, Resource>
  vpcAttributes: Record<string, VpcAttributes>
  vpcEndpoints: Record<string, Resource>
  subnets: Record<string, Resource>
  routeTables: Record<string, Resource>
  networkAcls: Record<string, Resource>
  securityGroups: Record<string, Resource>
  securityGroupRules: Record<string, Resource>
  internetGateways: Record<string, Resource>
  dhcpOptions: Record<string, Resource>
  networkInterfaces: Record<string, Resource>
  // NAT gateways and Elastic IP addresses, in the shape of CreateNatGateway / AllocateAddress output. Read by the
  // network model (src/app/api/network); the operations that create them are phase 4.
  natGateways: Record<string, Resource>
  addresses: Record<string, Resource>
}

export type Collection = Exclude<keyof Ec2State, 'defaultDhcpOptionsId' | 'vpcAttributes'>

export interface Scope {
  account: string
  region: string
}

// Which collection holds which resource type (used by tags and by Describe).
export const COLLECTIONS: Partial<Record<ResourceType, Collection>> = {
  vpc: 'vpcs',
  subnet: 'subnets',
  'route-table': 'routeTables',
  'network-acl': 'networkAcls',
  'security-group': 'securityGroups',
  'internet-gateway': 'internetGateways',
  'dhcp-options': 'dhcpOptions',
  'network-interface': 'networkInterfaces',
  'nat-gateway': 'natGateways',
  'elastic-ip': 'addresses',
}

const key = ({ account, region }: Scope): store.StoreKey => ({ service: 'ec2', account, region })

// A region's state is created on first use with its default VPC, as AWS provisions one in every region.
export function loadState(scope: Scope): Ec2State {
  assertValidRegion(scope.region)
  const existing = store.read<Ec2State | undefined>(key(scope), undefined)
  if (existing) {
    // collections added after a state file was written
    existing.networkInterfaces ??= {}
    existing.natGateways ??= {}
    existing.addresses ??= {}
    existing.vpcEndpoints ??= {}
    return existing
  }
  const state = emptyState(scope)
  createDefaultVpc(state, scope)
  saveState(scope, state)
  return state
}

export function saveState(scope: Scope, state: Ec2State) {
  store.write(key(scope), state)
}

// AWS creates a default VPC in every region that is enabled by default when an account is created.
export function provisionAccount(account: string) {
  for (const region of enableByDefaultRegions) {
    loadState({ account, region })
  }
}

function emptyState({ account, region }: Scope): Ec2State {
  const dhcpOptionsId = newResourceId('dhcp-options')
  return {
    defaultDhcpOptionsId: dhcpOptionsId,
    vpcs: {},
    vpcAttributes: {},
    vpcEndpoints: {},
    subnets: {},
    routeTables: {},
    networkAcls: {},
    securityGroups: {},
    securityGroupRules: {},
    internetGateways: {},
    networkInterfaces: {},
    natGateways: {},
    addresses: {},
    dhcpOptions: {
      [dhcpOptionsId]: {
        DhcpOptionsId: dhcpOptionsId,
        OwnerId: account,
        DhcpConfigurations: [
          { Key: 'domain-name', Values: [{ Value: regionDomain(region) }] },
          { Key: 'domain-name-servers', Values: [{ Value: 'AmazonProvidedDNS' }] },
        ],
        Tags: [],
      },
    },
  }
}

export const defaultVpc = (state: Ec2State) => Object.values(state.vpcs).find(vpc => vpc.IsDefault)

export interface NewVpc {
  cidr: string
  tenancy?: string
  tags?: Tag[]
  isDefault?: boolean
}

// Creating a VPC also creates its main route table, default network ACL and default security group.
export function createVpc(state: Ec2State, { account, region }: Scope, options: NewVpc): Resource {
  const vpcId = newResourceId('vpc')
  const vpc: Resource = {
    OwnerId: account,
    InstanceTenancy: options.tenancy ?? 'default',
    CidrBlockAssociationSet: [{
      AssociationId: newId('vpc-cidr-assoc'),
      CidrBlock: options.cidr,
      CidrBlockState: { State: 'associated' },
    }],
    IsDefault: options.isDefault ?? false,
    Tags: options.tags ?? [],
    VpcId: vpcId,
    State: 'available',
    CidrBlock: options.cidr,
    DhcpOptionsId: state.defaultDhcpOptionsId,
    BlockPublicAccessStates: { InternetGatewayBlockMode: 'off' },
  }
  state.vpcs[vpcId] = vpc
  state.vpcAttributes[vpcId] = {
    enableDnsSupport: true,
    enableDnsHostnames: options.isDefault ?? false,
    enableNetworkAddressUsageMetrics: false,
  }

  const routeTableId = newResourceId('route-table')
  state.routeTables[routeTableId] = {
    OwnerId: account,
    RouteTableId: routeTableId,
    VpcId: vpcId,
    Associations: [{
      Main: true,
      RouteTableAssociationId: newId('rtbassoc'),
      RouteTableId: routeTableId,
      AssociationState: { State: 'associated' },
    }],
    PropagatingVgws: [],
    Routes: [{ DestinationCidrBlock: options.cidr, GatewayId: 'local', Origin: 'CreateRouteTable', State: 'active' }],
    Tags: [],
  }

  addNetworkAcl(state, { account, region }, { vpcId, isDefault: true })

  const group = addSecurityGroup(state, { account, region }, { vpcId, name: 'default', description: 'default VPC security group' })
  for (const r of [
    securityGroupRule({ account, region }, group.GroupId, false, { ReferencedGroupInfo: { GroupId: group.GroupId, UserId: account } }),
    securityGroupRule({ account, region }, group.GroupId, true, { CidrIpv4: '0.0.0.0/0' }),
  ]) {
    state.securityGroupRules[r.SecurityGroupRuleId] = r
  }
  return vpc
}

// The default network ACL allows everything; a custom one starts with only the final deny rule (32767) per direction.
export function addNetworkAcl(state: Ec2State, { account }: Scope, options: { vpcId: string; isDefault?: boolean; tags?: Tag[] }): Resource {
  const entry = (egress: boolean, RuleNumber: number, RuleAction: string) =>
    ({ CidrBlock: '0.0.0.0/0', Egress: egress, Protocol: '-1', RuleAction, RuleNumber })
  const networkAclId = newResourceId('network-acl')
  const acl: Resource = {
    OwnerId: account,
    NetworkAclId: networkAclId,
    VpcId: options.vpcId,
    IsDefault: options.isDefault ?? false,
    Entries: options.isDefault
      ? [entry(true, 100, 'allow'), entry(true, 32767, 'deny'), entry(false, 100, 'allow'), entry(false, 32767, 'deny')]
      : [entry(true, 32767, 'deny'), entry(false, 32767, 'deny')],
    Associations: [],
    Tags: options.tags ?? [],
  }
  state.networkAcls[networkAclId] = acl
  return acl
}

// Adds the group only; the caller adds its rules (a new group gets one allow-all egress rule via the API, the default group also allows traffic from itself).
export function addSecurityGroup(
  state: Ec2State,
  { account, region }: Scope,
  options: { vpcId: string; name: string; description: string; tags?: Tag[] }
): Resource {
  const groupId = newResourceId('security-group')
  const group: Resource = {
    OwnerId: account,
    GroupId: groupId,
    GroupName: options.name,
    Description: options.description,
    VpcId: options.vpcId,
    SecurityGroupArn: `arn:${PARTITION}:ec2:${region}:${account}:security-group/${groupId}`,
    Tags: options.tags ?? [],
  }
  state.securityGroups[groupId] = group
  return group
}

export function securityGroupRule(
  { account, region }: Scope,
  groupId: string,
  IsEgress: boolean,
  extra: Record<string, unknown>
): Resource {
  const id = newId('sgr')
  return {
    SecurityGroupRuleId: id,
    GroupId: groupId,
    GroupOwnerId: account,
    IsEgress,
    IpProtocol: '-1',
    FromPort: -1,
    ToPort: -1,
    SecurityGroupRuleArn: `arn:${PARTITION}:ec2:${region}:${account}:security-group-rule/${id}`,
    Tags: [],
    ...extra,
  }
}

export function createSubnet(
  state: Ec2State,
  { account, region }: Scope,
  options: { vpcId: string; cidr: string; zone: { name: string; id: string }; tags?: Tag[]; isDefault?: boolean }
): Resource {
  const subnetId = newResourceId('subnet')
  const subnet: Resource = {
    SubnetId: subnetId,
    SubnetArn: `arn:${PARTITION}:ec2:${region}:${account}:subnet/${subnetId}`,
    State: 'available',
    OwnerId: account,
    VpcId: options.vpcId,
    CidrBlock: options.cidr,
    Ipv6CidrBlockAssociationSet: [],
    AvailableIpAddressCount: addressCount(parseCidr(options.cidr)!) - 5,
    AvailabilityZone: options.zone.name,
    AvailabilityZoneId: options.zone.id,
    DefaultForAz: options.isDefault ?? false,
    MapPublicIpOnLaunch: options.isDefault ?? false,
    MapCustomerOwnedIpOnLaunch: false,
    AssignIpv6AddressOnCreation: false,
    EnableDns64: false,
    Ipv6Native: false,
    PrivateDnsNameOptionsOnLaunch: {
      HostnameType: 'ip-name',
      EnableResourceNameDnsARecord: false,
      EnableResourceNameDnsAAAARecord: false,
    },
    BlockPublicAccessStates: { InternetGatewayBlockMode: 'off' },
    Tags: options.tags ?? [],
  }
  state.subnets[subnetId] = subnet
  const defaultAcl = Object.values(state.networkAcls).find(acl => acl.VpcId === options.vpcId && acl.IsDefault)
  defaultAcl?.Associations.push({
    NetworkAclAssociationId: newId('aclassoc'),
    NetworkAclId: defaultAcl.NetworkAclId,
    SubnetId: subnetId,
  })
  return subnet
}

const DEFAULT_VPC_CIDR = '172.31.0.0/16'

// Default subnets are the /20 blocks of 172.31.0.0/16 in order, one per availability zone.
export function nextDefaultSubnetCidr(state: Ec2State, vpcId: string): string {
  const used = new Set(Object.values(state.subnets).filter(s => s.VpcId === vpcId).map(s => s.CidrBlock))
  for (let i = 0; i < 16; i++) {
    const cidr = formatCidr({ address: parseCidr(DEFAULT_VPC_CIDR)!.address + i * 4096, prefix: 20 })
    if (!used.has(cidr)) {
      return cidr
    }
  }
  throw new Error('no free default subnet range')
}

export function createDefaultVpc(state: Ec2State, scope: Scope): Resource {
  const vpc = createVpc(state, scope, { cidr: DEFAULT_VPC_CIDR, isDefault: true })

  const igwId = newResourceId('internet-gateway')
  state.internetGateways[igwId] = {
    InternetGatewayId: igwId,
    OwnerId: scope.account,
    Attachments: [{ State: 'available', VpcId: vpc.VpcId }],
    Tags: [],
  }
  const mainRouteTable = Object.values(state.routeTables).find(rt => rt.VpcId === vpc.VpcId)!
  mainRouteTable.Routes.push({ DestinationCidrBlock: '0.0.0.0/0', GatewayId: igwId, Origin: 'CreateRoute', State: 'active' })

  for (const zone of availabilityZones(scope.region)) {
    createDefaultSubnet(state, scope, vpc.VpcId, zone)
  }
  return vpc
}

export function createDefaultSubnet(state: Ec2State, scope: Scope, vpcId: string, zone: { name: string; id: string }): Resource {
  return createSubnet(state, scope, { vpcId, cidr: nextDefaultSubnetCidr(state, vpcId), zone, isDefault: true })
}
