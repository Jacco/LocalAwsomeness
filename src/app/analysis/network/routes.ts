import { contains, parseCidr } from '../../api/data/ec2/cidr'
import type { Ec2State, Resource } from '../../api/data/ec2/state'

// Route tables, as the network model reads them. A route's `State` is not stored data: it follows its target, so a route
// to a gateway that was detached or deleted is a blackhole without anybody having to update the route.

export type RouteTarget =
  | { kind: 'local' }
  | { kind: 'internet-gateway'; id: string }
  | { kind: 'nat-gateway'; id: string }
  | { kind: 'network-interface'; id: string }
  | { kind: 'other'; id: string; type: string }

// Targets of routes that exist in the API but are not modelled yet (peering, transit gateway, ...).
const OTHER_TARGETS = [
  'GatewayId', 'VpcPeeringConnectionId', 'TransitGatewayId', 'InstanceId',
  'EgressOnlyInternetGatewayId', 'CarrierGatewayId', 'LocalGatewayId', 'CoreNetworkArn',
]

export function routeTarget(route: Resource): RouteTarget {
  if (route.GatewayId === 'local') {
    return { kind: 'local' }
  }
  if (typeof route.GatewayId === 'string' && route.GatewayId.startsWith('igw-')) {
    return { kind: 'internet-gateway', id: route.GatewayId }
  }
  if (route.NatGatewayId) {
    return { kind: 'nat-gateway', id: route.NatGatewayId }
  }
  if (route.NetworkInterfaceId) {
    return { kind: 'network-interface', id: route.NetworkInterfaceId }
  }
  const type = OTHER_TARGETS.find(field => route[field])
  return { kind: 'other', id: type ? route[type] : 'unknown', type: type ?? 'unknown' }
}

export function effectiveRouteState(state: Ec2State, vpcId: string, route: Resource): 'active' | 'blackhole' {
  const target = routeTarget(route)
  switch (target.kind) {
    case 'local':
      return 'active'
    case 'internet-gateway':
      return state.internetGateways[target.id]?.Attachments.some((a: { VpcId: string }) => a.VpcId === vpcId) ? 'active' : 'blackhole'
    case 'nat-gateway': {
      const nat = state.natGateways[target.id]
      return nat && !['deleting', 'deleted', 'failed'].includes(nat.State) ? 'active' : 'blackhole'
    }
    case 'network-interface': {
      const eni = state.networkInterfaces[target.id]
      return eni && eni.Status === 'in-use' ? 'active' : 'blackhole'
    }
    default:
      // Not modelled: keep what is stored.
      return route.State === 'blackhole' ? 'blackhole' : 'active'
  }
}

// A subnet uses the route table it is explicitly associated with, else the main route table of its VPC.
export function routeTableFor(state: Ec2State, subnet: Resource): { table: Resource; how: 'explicit' | 'main' } {
  const tables = Object.values(state.routeTables).filter(t => t.VpcId === subnet.VpcId)
  const explicit = tables.find(t => t.Associations.some((a: { SubnetId?: string }) => a.SubnetId === subnet.SubnetId))
  if (explicit) {
    return { table: explicit, how: 'explicit' }
  }
  const main = tables.find(t => t.Associations.some((a: { Main?: boolean }) => a.Main))
  if (!main) {
    throw new Error(`VPC ${subnet.VpcId} has no main route table`)
  }
  return { table: main, how: 'main' }
}

export interface RouteLookup {
  // The most specific route that contains the address.
  match?: Resource
  // Every route of the table that contains the address, most specific first.
  candidates: Resource[]
  // Routes that cannot match an IPv4 address here: IPv6 and prefix list destinations (not modelled yet).
  skipped: Resource[]
}

export function lookupRoute(table: Resource, address: number): RouteLookup {
  const candidates: { route: Resource; prefix: number }[] = []
  const skipped: Resource[] = []
  for (const route of table.Routes as Resource[]) {
    const cidr = route.DestinationCidrBlock ? parseCidr(route.DestinationCidrBlock) : undefined
    if (!cidr) {
      skipped.push(route)
    } else if (contains(cidr, { address, prefix: 32 })) {
      candidates.push({ route, prefix: cidr.prefix })
    }
  }
  candidates.sort((a, b) => b.prefix - a.prefix)
  return { match: candidates[0]?.route, candidates: candidates.map(c => c.route), skipped }
}

export function describeRoute(route: Resource): string {
  const destination = route.DestinationCidrBlock ?? route.DestinationIpv6CidrBlock ?? route.DestinationPrefixListId ?? '?'
  const target = routeTarget(route)
  return `${destination} -> ${target.kind === 'local' ? 'local' : target.id}`
}
