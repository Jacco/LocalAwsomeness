import { contains, parseAddress, parseCidr } from '../../api/data/ec2/cidr'
import { nextPrivateIp } from '../../api/data/ec2/interfaces'
import { loadState, type Ec2State, type Resource } from '../../api/data/ec2/state'
import { accountDirExists } from '../../api/data/store'
import { reachPublicService, type Source } from "./reach"
import { renderTrace, type Trace } from "./trace"

// The network model against the state of the running simulator, for looking at a trace by hand (scripts/reach.py,
// scripts/scenario/network.py) and later for the consoles. It resolves a source the way a person names it (a subnet and
// security groups by id or Name tag, or an existing network interface), fills in what is left out and says so.

export interface ReachRequest {
  account: string
  region: string
  from: {
    // An existing network interface, or ...
    networkInterfaceId?: string
    // ... a subnet and security groups, by id or Name tag (security groups also by group name).
    subnet?: string
    securityGroups?: string[]
    privateIp?: string
    publicIp?: string
    description?: string
  }
  to: { host: string; port?: number }
  sourcePort?: number
}

export interface ReachResult {
  trace: Trace
  text: string
  // What was not given and had to be assumed (an address, a default security group).
  assumptions: string[]
}

// A request that cannot be answered because of what the caller asked (unknown subnet, ambiguous name): HTTP 400.
export class BadReachRequest extends Error {}

const nameTag = (resource: Resource): string | undefined => resource.Tags?.find((t: { Key: string }) => t.Key === 'Name')?.Value

function pick(items: Resource[], ref: string, what: string, idOf: (r: Resource) => string, names: (r: Resource) => (string | undefined)[]): Resource {
  const found = items.filter(item => idOf(item) === ref || names(item).includes(ref))
  if (found.length === 0) {
    throw new BadReachRequest(`No ${what} '${ref}' (by id or name)`)
  }
  if (found.length > 1) {
    throw new BadReachRequest(`${what} '${ref}' is ambiguous: ${found.map(idOf).join(', ')}`)
  }
  return found[0]
}

export function resolveSource(state: Ec2State, from: ReachRequest['from']): { source: Source; assumptions: string[] } {
  const assumptions: string[] = []
  let subnet: Resource
  let groupIds: string[]
  let privateIp: string | undefined = from.privateIp
  let publicIp: string | undefined = from.publicIp
  let description = from.description

  if (from.networkInterfaceId) {
    const eni = state.networkInterfaces[from.networkInterfaceId]
    if (!eni) {
      throw new BadReachRequest(`No network interface '${from.networkInterfaceId}'`)
    }
    subnet = state.subnets[eni.SubnetId]
    groupIds = (eni.Groups ?? []).map((g: { GroupId: string }) => g.GroupId)
    if (groupIds.length === 0) {
      throw new BadReachRequest(`Network interface '${eni.NetworkInterfaceId}' has no security groups (it is managed by an AWS service); name a subnet and security groups instead`)
    }
    privateIp ??= eni.PrivateIpAddress
    publicIp ??= eni.Association?.PublicIp
    description ??= `interface ${eni.NetworkInterfaceId}`
  } else {
    if (!from.subnet) {
      throw new BadReachRequest('Say where the connection starts: a subnet (id or Name) with security groups, or a network interface')
    }
    subnet = pick(Object.values(state.subnets), from.subnet, 'subnet', s => s.SubnetId, s => [nameTag(s)])
    const groups = Object.values(state.securityGroups).filter(g => g.VpcId === subnet.VpcId)
    if (from.securityGroups?.length) {
      groupIds = from.securityGroups.map(ref => pick(groups, ref, 'security group', g => g.GroupId, g => [g.GroupName, nameTag(g)]).GroupId)
    } else {
      const fallback = groups.find(g => g.GroupName === 'default')!
      groupIds = [fallback.GroupId]
      assumptions.push(`no security group given: the default group of ${subnet.VpcId} (${fallback.GroupId}) is used`)
    }
  }

  if (privateIp === undefined) {
    privateIp = nextPrivateIp(state, subnet)
    assumptions.push(`no private address given: ${privateIp}, the next free address of ${subnet.SubnetId}`)
  } else if (!contains(parseCidr(subnet.CidrBlock)!, { address: parseAddress(privateIp) ?? -1, prefix: 32 })) {
    throw new BadReachRequest(`Private address '${privateIp}' is not in ${subnet.SubnetId} (${subnet.CidrBlock})`)
  }
  if (publicIp !== undefined && parseAddress(publicIp) === undefined) {
    throw new BadReachRequest(`Public address '${publicIp}' is not an IPv4 address`)
  }
  return {
    source: { description: description ?? 'the connection', subnetId: subnet.SubnetId, securityGroupIds: groupIds, privateIp, publicIp },
    assumptions,
  }
}

export function inspectReach(request: ReachRequest): ReachResult {
  if (!request.account || !accountDirExists(request.account)) {
    throw new BadReachRequest(`Unknown account '${request.account}'`)
  }
  if (!request.region) {
    throw new BadReachRequest('A region is required')
  }
  if (!request.to?.host) {
    throw new BadReachRequest('Say where the connection goes: to.host')
  }
  const port = request.to.port ?? 443
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BadReachRequest(`Port '${request.to.port}' is not a port number`)
  }
  const state = loadState({ account: request.account, region: request.region })
  const { source, assumptions } = resolveSource(state, request.from ?? {})
  const trace = reachPublicService(state, source, { host: request.to.host, port }, { sourcePort: request.sourcePort })
  return { trace, text: renderTrace(trace), assumptions }
}
