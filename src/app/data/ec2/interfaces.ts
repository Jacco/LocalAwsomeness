import { randomBytes } from "crypto"
import { AwsError } from '../../api/common'
import { QUOTAS, quota } from '../../api/quotas"
import { addressCount, firstAddress, formatAddress, lastAddress, parseAddress, parseCidr } from "./cidr"
import { newResourceId } from "./ids"
import { regionDomain } from "./regions"
import type { Ec2State, Resource, Scope, Tag } from "./state"

// Addresses in subnets and the network interfaces that use them. The number of free addresses of a subnet is derived from
// the interfaces in it, never stored, so deleting an interface (or a NAT gateway that owns one) gives the address back.

// AWS reserves the first four and the last address of every subnet.
const RESERVED_AT_START = 4
const RESERVED_AT_END = 1

// Public addresses of Elastic IPs are stand-ins from the benchmarking range 198.18.0.0/15, not real addresses.
const PUBLIC_POOL_START = parseAddress('198.18.0.0')!
const PUBLIC_POOL_SIZE = 2 ** 17

const privateIps = (eni: Resource): string[] =>
  (eni.PrivateIpAddresses ?? [{ PrivateIpAddress: eni.PrivateIpAddress }]).map((a: { PrivateIpAddress: string }) => a.PrivateIpAddress)

function usedIps(state: Ec2State, subnetId: string): Set<number> {
  const used = new Set<number>()
  for (const eni of Object.values(state.networkInterfaces)) {
    if (eni.SubnetId === subnetId) {
      for (const ip of privateIps(eni)) {
        const address = parseAddress(ip)
        if (address !== undefined) {
          used.add(address)
        }
      }
    }
  }
  return used
}

export function availableAddressCount(state: Ec2State, subnet: Resource): number {
  const cidr = parseCidr(subnet.CidrBlock)!
  return addressCount(cidr) - RESERVED_AT_START - RESERVED_AT_END - usedIps(state, subnet.SubnetId).size
}

// The lowest free address of the subnet.
export function nextPrivateIp(state: Ec2State, subnet: Resource): string {
  const cidr = parseCidr(subnet.CidrBlock)!
  const used = usedIps(state, subnet.SubnetId)
  for (let address = firstAddress(cidr) + RESERVED_AT_START; address <= lastAddress(cidr) - RESERVED_AT_END; address++) {
    if (!used.has(address)) {
      return formatAddress(address)
    }
  }
  throw new AwsError('InsufficientFreeAddressesInSubnet', `There are not enough free addresses in subnet '${subnet.SubnetId}' to satisfy the requested number of addresses.`)
}

export function allocatePublicIp(state: Ec2State): string {
  const taken = new Set(Object.values(state.addresses).map(a => a.PublicIp))
  for (;;) {
    const ip = formatAddress(PUBLIC_POOL_START + 256 + (randomBytes(4).readUInt32BE() % (PUBLIC_POOL_SIZE - 512)))
    if (!taken.has(ip)) {
      return ip
    }
  }
}

export interface NewInterface {
  subnetId: string
  description: string
  interfaceType: string
  // Created and owned by an AWS service (a NAT gateway, Lambda, an endpoint); the owner cannot delete it directly.
  requesterManaged: boolean
  sourceDestCheck?: boolean
  groups?: { GroupId: string; GroupName: string }[]
  tags?: Tag[]
}

const randomMac = () => ['0a', ...Array.from({ length: 5 }, () => randomBytes(1).toString('hex'))].join(':')

export function createInterface(state: Ec2State, { account, region }: Scope, options: NewInterface): Resource {
  const subnet = state.subnets[options.subnetId]
  if (Object.keys(state.networkInterfaces).length >= quota({ account, region }, QUOTAS.networkInterfacesPerRegion)) {
    throw new AwsError('NetworkInterfaceLimitExceeded', 'You have reached the limit on the number of network interfaces that you can create.')
  }
  const privateIp = nextPrivateIp(state, subnet)
  const dnsName = `ip-${privateIp.replace(/\./g, '-')}.${regionDomain(region)}`
  const id = newResourceId('network-interface')
  const eni: Resource = {
    NetworkInterfaceId: id,
    SubnetId: subnet.SubnetId,
    VpcId: subnet.VpcId,
    AvailabilityZone: subnet.AvailabilityZone,
    AvailabilityZoneId: subnet.AvailabilityZoneId,
    Description: options.description,
    OwnerId: account,
    RequesterId: options.requesterManaged ? 'amazon-aws' : account,
    RequesterManaged: options.requesterManaged,
    InterfaceType: options.interfaceType,
    Status: 'in-use',
    MacAddress: randomMac(),
    PrivateIpAddress: privateIp,
    PrivateDnsName: dnsName,
    PrivateIpAddresses: [{ Primary: true, PrivateIpAddress: privateIp, PrivateDnsName: dnsName }],
    Ipv6Addresses: [],
    SourceDestCheck: options.sourceDestCheck ?? true,
    Groups: options.groups ?? [],
    Tags: options.tags ?? [],
  }
  state.networkInterfaces[id] = eni
  return eni
}
