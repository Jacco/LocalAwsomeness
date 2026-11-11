import { createHash } from "crypto"
import { contains, parseAddress, parseCidr } from "../db/ec2/cidr"
import type { Ec2State, Resource, Tag } from "../db/ec2/state"
import { describeRoute, effectiveRouteState, lookupRoute, routeTableFor, routeTarget } from "./routes"
import { summarize, type Cause, type Evidence, type Phase, type RequestContext, type Step, type Trace } from "./trace"

// Network model v0: can a connection from a network interface reach a public service name or address, and why (not)?
// Pure functions over the EC2 state; nothing here opens a socket. See docs/walking-skeleton.md.
//
// Modelled: the VPC resolver (public names only), security group egress, network ACLs for the packet and its return
// traffic, the route table of the subnet, internet gateways and public NAT gateways, the source address that results.
// Not modelled yet (said in the trace, never guessed): interface and gateway endpoints, private hosted zones, IPv6,
// destinations inside a VPC, other route targets (peering, transit gateway, ...), prefix lists, NAT gateway return paths.

// Where the connection starts: a network interface in a subnet.
export interface Source {
  description: string
  subnetId: string
  securityGroupIds: string[]
  privateIp: string
  // The public IPv4 address of the interface (Elastic IP or auto-assigned), when it has one.
  publicIp?: string
}

export interface Destination {
  host: string
  port: number
}

export interface ReachOptions {
  // The client's port, for the return traffic that a network ACL (stateless) has to allow. The shim knows the real one.
  sourcePort?: number
}

const DEFAULT_SOURCE_PORT = 49152

const nameOf = (resource?: Resource): string | undefined => resource?.Tags?.find((t: Tag) => t.Key === 'Name')?.Value

function evidence(kind: Evidence['kind'], id: string, resource?: Resource, note?: string): Evidence {
  return { kind, id, name: nameOf(resource), note }
}

const named = (id: string, resource?: Resource) => (nameOf(resource) ? `${id} (${nameOf(resource)})` : id)

// Public service addresses are stand-ins from the documentation range 198.51.100.0/24 until the real ranges
// (ip-ranges.json) become reference data.
export function servicePublicAddress(host: string): string {
  const byte = createHash('sha256').update(host.toLowerCase()).digest()[0]
  return `198.51.100.${1 + (byte % 253)}`
}

const HINTS: Record<Cause, (d: Destination) => string> = {
  'dns-resolver-disabled': () => 'enable DNS support (enableDnsSupport) on the VPC, or use a resolver of your own',
  'no-route': () => 'add a route for the destination (for example 0.0.0.0/0) to a NAT gateway from a private subnet or to an internet gateway from a public one, or create an endpoint for the service',
  'blackhole-route': () => 'the target of the route no longer exists: recreate it or point the route at a gateway that exists',
  'no-public-ip': () => 'give the interface a public IPv4 address (Elastic IP), or route through a NAT gateway',
  'security-group-blocks': d => `add an egress rule for tcp/${d.port} to the destination to a security group of the interface`,
  'nacl-blocks': () => 'allow the traffic in the network ACL of the subnet; a network ACL is stateless, so the return traffic needs a rule in the other direction too',
  'nat-gateway-unavailable': () => 'wait for the NAT gateway to become available, or replace it',
  'nat-gateway-private': () => 'a private NAT gateway cannot reach the internet: use a public NAT gateway',
  'nat-without-internet-route': () => 'the subnet of the NAT gateway needs a route to an internet gateway',
  'policy-deny': () => 'update the VPC endpoint resource-based policy to allow access from your principal',
  'not-modelled': () => 'this part of the path is not modelled yet',
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

function dnsStep(state: Ec2State, vpcId: string, host: string): { step: Step; address?: string } {
  const vpc = state.vpcs[vpcId]
  const literal = parseAddress(host)
  if (literal !== undefined) {
    return {
      address: host,
      step: { phase: 'dns', decision: 'info', summary: `${host} is an address, no lookup is needed`, detail: [], evidence: [] },
    }
  }
  if (state.vpcAttributes[vpcId]?.enableDnsSupport === false) {
    return {
      step: {
        phase: 'dns',
        decision: 'deny',
        cause: 'dns-resolver-disabled',
        summary: `${host} cannot be resolved: DNS support is disabled in ${named(vpcId, vpc)}`,
        detail: [
          `Asked: which address does ${host} resolve to from this VPC?`,
          'Found: enableDnsSupport is false, so the VPC resolver does not answer, and no other resolver is configured.',
        ],
        evidence: [evidence('vpc', vpcId, vpc, 'enableDnsSupport=false')],
      },
    }
  }
  const address = servicePublicAddress(host)
  return {
    address,
    step: {
      phase: 'dns',
      decision: 'allow',
      summary: `${host} resolves to ${address}`,
      detail: [
        `Asked: which address does ${host} resolve to from ${named(vpcId, vpc)}?`,
        'Found: the VPC resolver is on (enableDnsSupport) and answers with the public address.',
        `Address: ${address} is a stand-in from the documentation range 198.51.100.0/24, not a real service address.`,
        'Not modelled yet: interface endpoints with private DNS and private hosted zones, which would change this answer.',
      ],
      evidence: [evidence('dns', host, undefined, address)],
    },
  }
}

function ruleText(rule: Resource): string {
  const protocol = rule.IpProtocol === '-1' ? 'all traffic' : `${rule.IpProtocol} ${rule.FromPort === rule.ToPort ? rule.FromPort : `${rule.FromPort}-${rule.ToPort}`}`
  const peer = rule.CidrIpv4 ?? rule.CidrIpv6 ?? rule.PrefixListId ?? rule.ReferencedGroupInfo?.GroupId ?? '?'
  return `${protocol} ${rule.IsEgress ? 'to' : 'from'} ${peer}`
}

function securityGroupStep(state: Ec2State, groupIds: string[], address: number, port: number, destinationText: string): Step {
  const rules = Object.values(state.securityGroupRules).filter(r => groupIds.includes(r.GroupId) && r.IsEgress)
  const allows = (rule: Resource) =>
    rule.CidrIpv4 !== undefined
    && contains(parseCidr(rule.CidrIpv4)!, { address, prefix: 32 })
    && (rule.IpProtocol === '-1' || (rule.IpProtocol === 'tcp' && rule.FromPort <= port && port <= rule.ToPort))
  const match = rules.find(allows)
  const groups = groupIds.map(id => evidence('security-group', id, state.securityGroups[id]))
  if (match) {
    return {
      phase: 'security-group-out',
      decision: 'allow',
      summary: `egress allowed by ${named(match.GroupId, state.securityGroups[match.GroupId])}: ${ruleText(match)}`,
      detail: [
        `Asked: does a security group of the interface allow tcp/${port} to ${destinationText}?`,
        `Found: ${match.SecurityGroupRuleId} (${ruleText(match)}) matches. Security groups are stateful, so the return traffic is allowed without a rule.`,
      ],
      evidence: [...groups.filter(g => g.id === match.GroupId), evidence('security-group-rule', match.SecurityGroupRuleId, match, ruleText(match))],
    }
  }
  const listed = groupIds.map(id => {
    const own = rules.filter(r => r.GroupId === id)
    return `${named(id, state.securityGroups[id])} egress rules: ${own.length ? own.map(ruleText).join('; ') : 'none'}`
  })
  return {
    phase: 'security-group-out',
    decision: 'deny',
    cause: 'security-group-blocks',
    summary: `no egress rule of ${groupIds.join(', ')} allows tcp/${port} to ${destinationText}`,
    detail: [
      `Asked: does a security group of the interface allow tcp/${port} to ${destinationText}?`,
      ...listed,
      'Security groups have no deny rules: without a matching allow the packet is dropped, which the client sees as a timeout.',
    ],
    evidence: groups,
  }
}

function networkAclFor(state: Ec2State, subnet: Resource): { acl: Resource; how: 'associated' | 'default' } {
  const acls = Object.values(state.networkAcls).filter(a => a.VpcId === subnet.VpcId)
  const associated = acls.find(a => a.Associations.some((x: { SubnetId: string }) => x.SubnetId === subnet.SubnetId))
  if (associated) {
    return { acl: associated, how: 'associated' }
  }
  const fallback = acls.find(a => a.IsDefault)
  if (!fallback) {
    throw new Error(`VPC ${subnet.VpcId} has no default network ACL`)
  }
  return { acl: fallback, how: 'default' }
}

function entryText(entry: Resource): string {
  const protocol = entry.Protocol === '-1' ? 'all traffic' : entry.Protocol === '6' ? `tcp ${entry.PortRange?.From}-${entry.PortRange?.To}` : `protocol ${entry.Protocol}`
  return `rule ${entry.RuleNumber} ${entry.RuleAction} ${protocol} ${entry.Egress ? 'to' : 'from'} ${entry.CidrBlock ?? entry.Ipv6CidrBlock}`
}

// The last rule of every network ACL; it denies whatever no rule below it allowed.
const FINAL_RULE = 32767

// Rules are evaluated in rule number order and the first match decides.
function evaluateNacl(acl: Resource, egress: boolean, address: number, port: number): Resource | undefined {
  const entries = (acl.Entries as Resource[]).filter(e => e.Egress === egress).sort((a, b) => a.RuleNumber - b.RuleNumber)
  return entries.find(entry =>
    entry.CidrBlock !== undefined
    && contains(parseCidr(entry.CidrBlock)!, { address, prefix: 32 })
    && (entry.Protocol === '-1' || (entry.Protocol === '6' && entry.PortRange.From <= port && port <= entry.PortRange.To)))
}

function naclStep(
  state: Ec2State, subnet: Resource, phase: 'nacl-out' | 'nacl-in', address: number, port: number, text: { ask: string; noun: string }
): Step {
  const egress = phase === 'nacl-out'
  const { acl, how } = networkAclFor(state, subnet)
  const entry = evaluateNacl(acl, egress, address, port)
  const aclText = `${named(acl.NetworkAclId, acl)} (${how === 'default' ? 'the default ACL of the VPC' : `associated with ${subnet.SubnetId}`})`
  const considered = (acl.Entries as Resource[]).filter(e => e.Egress === egress).sort((a, b) => a.RuleNumber - b.RuleNumber).map(entryText)
  if (entry?.RuleAction === 'allow') {
    return {
      phase, decision: 'allow',
      summary: `${text.noun} allowed by ${acl.NetworkAclId} ${entryText(entry)}`,
      detail: [`Asked: ${text.ask}`, `Found: ${aclText}; ${entryText(entry)} is the first rule that matches.`],
      evidence: [evidence('network-acl', acl.NetworkAclId, acl), evidence('network-acl-entry', String(entry.RuleNumber), undefined, entryText(entry))],
    }
  }
  return {
    phase, decision: 'deny', cause: 'nacl-blocks',
    summary: entry
      ? `${text.noun} denied by ${acl.NetworkAclId} ${entryText(entry)}`
      : `${text.noun} denied: no rule of ${acl.NetworkAclId} matches`,
    detail: [
      `Asked: ${text.ask}`,
      `Found: ${aclText}.`,
      `Rules in order: ${considered.join('; ')}.`,
      entry ? `${entryText(entry)} is the first match and it denies.` : 'No rule matches; the implicit deny applies.',
      ...(entry?.RuleNumber === FINAL_RULE ? [`No rule below it allowed this traffic, so the final rule (${FINAL_RULE}) denies it.`] : []),
      'A network ACL is stateless: every packet, and the answer to an allowed packet, is checked against its own rules.',
    ],
    evidence: [evidence('network-acl', acl.NetworkAclId, acl), ...(entry ? [evidence('network-acl-entry', String(entry.RuleNumber), undefined, entryText(entry))] : [])],
  }
}

interface RoutePick {
  step: Step
  // What the route leads to, when there is a usable route.
  target?: ReturnType<typeof routeTarget>
}

function routeStep(state: Ec2State, subnet: Resource, address: number, addressText: string): RoutePick {
  const { table, how } = routeTableFor(state, subnet)
  const { match, candidates, skipped } = lookupRoute(table, address)
  const tableText = `${named(table.RouteTableId, table)} (${how === 'explicit' ? `explicit association of ${subnet.SubnetId}` : `main route table of ${subnet.VpcId}`})`
  const routes = (table.Routes as Resource[]).map(r => `${describeRoute(r)}${effectiveRouteState(state, subnet.VpcId, r) === 'blackhole' ? ' [blackhole]' : ''}`)
  const detail = [`Asked: which route of ${subnet.SubnetId} leads to ${addressText}?`, `Found: ${tableText} has ${routes.join('; ') || 'no routes'}.`]
  if (skipped.length) {
    detail.push(`Not modelled yet: ${skipped.length} route(s) with an IPv6 or prefix list destination were not considered.`)
  }
  const ev = [evidence('route-table', table.RouteTableId, table, how)]
  if (!match) {
    return {
      step: {
        phase: 'route', decision: 'no-match', cause: 'no-route',
        summary: `no route of ${table.RouteTableId} matches ${addressText}`,
        detail: [...detail, 'Result: no route contains the address, so the packet cannot leave the subnet.'],
        evidence: ev,
      },
    }
  }
  const target = routeTarget(match)
  const state_ = effectiveRouteState(state, subnet.VpcId, match)
  const others = candidates.slice(1).map(describeRoute)
  detail.push(`Result: ${describeRoute(match)} is the most specific match${others.length ? ` (less specific: ${others.join('; ')})` : ''}.`)
  ev.push(evidence('route', describeRoute(match), undefined, state_))
  if (state_ === 'blackhole') {
    return {
      step: {
        phase: 'route', decision: 'deny', cause: 'blackhole-route',
        summary: `route ${describeRoute(match)} is a blackhole: its target does not exist`,
        detail: [...detail, `The route state follows its target; ${target.kind === 'local' ? 'local' : target.id} is ${target.kind === 'internet-gateway' ? 'not attached to this VPC or does not exist' : 'deleted or does not exist'}.`],
        evidence: ev,
      },
    }
  }
  if (target.kind === 'local' || target.kind === 'other') {
    return {
      step: {
        phase: 'route', decision: 'not-modelled', cause: 'not-modelled',
        summary: target.kind === 'local'
          ? `${addressText} is inside the VPC: destinations inside a VPC are not modelled yet`
          : `route target ${target.id} (${target.type}) is not modelled yet`,
        detail,
        evidence: ev,
      },
    }
  }
  return {
    target,
    step: { phase: 'route', decision: 'allow', summary: `route ${describeRoute(match)} sends the packet to ${target.id}`, detail, evidence: ev },
  }
}

// Direct path: the interface itself has to have a public address, the internet gateway translates it.
function internetGatewayStep(state: Ec2State, subnet: Resource, igwId: string, publicIp: string | undefined, via: string): Step {
  const igw = state.internetGateways[igwId]
  const attached = igw?.Attachments.some((a: { VpcId: string }) => a.VpcId === subnet.VpcId)
  const ev = [evidence('internet-gateway', igwId, igw)]
  if (!publicIp) {
    return {
      phase: 'internet-gateway', decision: 'deny', cause: 'no-public-ip',
      summary: `${igwId} cannot be used: the source has no public IPv4 address`,
      detail: [
        `Asked: can ${via} send the packet out through ${igwId}?`,
        'Found: an internet gateway translates a private address to the public one of the interface; this interface has none, so the packet is dropped.',
      ],
      evidence: ev,
    }
  }
  return {
    phase: 'internet-gateway', decision: attached ? 'allow' : 'deny', cause: attached ? undefined : 'blackhole-route',
    summary: `${igwId} translates the source to ${publicIp}`,
    detail: [`Asked: can ${via} send the packet out through ${igwId}?`, `Found: ${igwId} is attached to ${subnet.VpcId}; the source address on the internet is ${publicIp}.`],
    evidence: ev,
  }
}

interface NatPath {
  step: Step
  publicIp?: string
  // The internet gateway behind the NAT gateway, when the path got that far.
  igwId?: string
}

// Public NAT gateway: it must be available, its subnet's ACL must pass the traffic, and its own subnet needs the route
// to an internet gateway; the source on the internet is the NAT gateway's Elastic IP.
function natGatewayStep(state: Ec2State, source: Source, natId: string, address: number, addressText: string, port: number): NatPath {
  const nat = state.natGateways[natId]
  const ev: Evidence[] = [evidence('nat-gateway', natId, nat)]
  const fail = (cause: Cause, summary: string, detail: string[], extra: Evidence[] = []): NatPath => ({
    step: { phase: 'nat-gateway', decision: 'deny', cause, summary, detail: [`Asked: can ${natId} forward the packet to ${addressText}?`, ...detail], evidence: [...ev, ...extra] },
  })
  if (nat.State !== 'available') {
    return fail('nat-gateway-unavailable', `${natId} is ${nat.State}, not available`, ['Found: a NAT gateway only forwards traffic when it is available.'])
  }
  if (nat.ConnectivityType === 'private') {
    return fail('nat-gateway-private', `${natId} is a private NAT gateway`, ['Found: a private NAT gateway has no Elastic IP and no route to an internet gateway; it only reaches other networks of yours.'])
  }
  const natSubnet = state.subnets[nat.SubnetId]
  const detail: string[] = [`Found: ${natId} is in ${named(natSubnet.SubnetId, natSubnet)}.`]
  const inbound = naclStep(state, natSubnet, 'nacl-in', parseAddress(source.privateIp)!, port, {
    ask: `does the network ACL of ${natSubnet.SubnetId} let the packet from ${source.privateIp} to ${addressText} in?`, noun: 'inbound',
  })
  const outbound = naclStep(state, natSubnet, 'nacl-out', address, port, {
    ask: `does the network ACL of ${natSubnet.SubnetId} let the translated packet to ${addressText} out?`, noun: 'outbound',
  })
  for (const [step, text] of [[inbound, `the packet from ${source.privateIp} entering the subnet of the NAT gateway`], [outbound, `the translated packet leaving it towards ${addressText}`]] as const) {
    if (step.decision === 'deny') {
      return fail('nacl-blocks', `the network ACL of ${natSubnet.SubnetId} blocks ${text}`, [...detail, ...step.detail.slice(1)], step.evidence)
    }
    detail.push(`Network ACL: ${step.summary} (${text}).`)
  }
  const { table, how } = routeTableFor(state, natSubnet)
  const { match } = lookupRoute(table, address)
  const target = match ? routeTarget(match) : undefined
  const tableEvidence = evidence('route-table', table.RouteTableId, table, how)
  if (!match || !target || target.kind !== 'internet-gateway' || effectiveRouteState(state, natSubnet.VpcId, match) !== 'active') {
    const what = !match ? `has no route for ${addressText}` : `routes ${describeRoute(match)}, which is not a working internet gateway`
    return fail('nat-without-internet-route', `${natId} cannot reach the internet: the route table of its subnet ${what}`, [
      ...detail,
      `Found: ${named(table.RouteTableId, table)} (${how === 'explicit' ? 'explicit association' : 'main route table'}) ${what}; routes: ${(table.Routes as Resource[]).map(describeRoute).join('; ')}.`,
      'A public NAT gateway sits in a public subnet: a subnet whose route table sends internet traffic to an internet gateway.',
    ], [tableEvidence])
  }
  const publicIp = nat.NatGatewayAddresses?.[0]?.PublicIp as string | undefined
  if (!publicIp) {
    return fail('no-public-ip', `${natId} has no Elastic IP address`, [...detail])
  }
  return {
    publicIp,
    igwId: target.id,
    step: {
      phase: 'nat-gateway', decision: 'allow',
      summary: `${natId} forwards the packet; the source on the internet is its Elastic IP ${publicIp}`,
      detail: [
        `Asked: can ${natId} forward the packet to ${addressText}?`,
        ...detail,
        `Route: ${named(table.RouteTableId, table)} sends ${describeRoute(match)}.`,
        'Not modelled yet: the return path through the NAT gateway (translated ports against the network ACL of its subnet).',
      ],
      evidence: [...ev, evidence('address', publicIp), tableEvidence],
    },
  }
}

// ---------------------------------------------------------------------------
// the model
// ---------------------------------------------------------------------------

export function reachPublicService(state: Ec2State, source: Source, destination: Destination, options: ReachOptions = {}): Trace {
  const subnet = state.subnets[source.subnetId]
  if (!subnet) {
    throw new Error(`Unknown subnet ${source.subnetId}`)
  }
  const sourcePort = options.sourcePort ?? DEFAULT_SOURCE_PORT
  const from = `${source.description} (${named(subnet.SubnetId, subnet)}, ${source.securityGroupIds.join(', ')})`
  const intent = `${destination.port === 443 ? 'HTTPS' : `tcp/${destination.port}`} to ${destination.host}:${destination.port}`
  const steps: Step[] = []
  let context: RequestContext | undefined

  const dns = dnsStep(state, subnet.VpcId, destination.host)
  steps.push(dns.step)
  const skip = (phase: Phase, why: string): Step => ({ phase, decision: 'not-evaluated', summary: why, detail: [], evidence: [] })

  if (dns.address === undefined) {
    const why = 'not evaluated: there is no address to evaluate'
    steps.push(skip('security-group-out', why), skip('nacl-out', why), skip('route', why), skip('nacl-in', why), skip('delivery', why))
  } else {
    const address = parseAddress(dns.address)!
    const addressText = dns.address
    // Independent checks are all evaluated, so every problem shows up at once.
    steps.push(securityGroupStep(state, source.securityGroupIds, address, destination.port, addressText))
    steps.push(naclStep(state, subnet, 'nacl-out', address, destination.port, { ask: `does the network ACL of ${subnet.SubnetId} allow tcp/${destination.port} to ${addressText}?`, noun: 'outbound' }))
    const route = routeStep(state, subnet, address, addressText)
    steps.push(route.step)
    let publicIp: string | undefined
    let path: RequestContext | undefined
    if (route.target?.kind === 'internet-gateway') {
      const step = internetGatewayStep(state, subnet, route.target.id, source.publicIp, source.description)
      steps.push(step)
      if (step.decision === 'allow') {
        publicIp = source.publicIp
        path = { path: 'internet-gateway', sourceIp: publicIp }
      }
    } else if (route.target?.kind === 'nat-gateway') {
      const nat = natGatewayStep(state, source, route.target.id, address, addressText, destination.port)
      steps.push(nat.step)
      if (nat.step.decision === 'allow') {
        steps.push(internetGatewayStep(state, state.subnets[state.natGateways[route.target.id].SubnetId], nat.igwId!, nat.publicIp, route.target.id))
        publicIp = nat.publicIp
        path = { path: 'nat-gateway', natGatewayId: route.target.id, sourceIp: nat.publicIp }
      }
    }
    steps.push(naclStep(state, subnet, 'nacl-in', address, sourcePort, {
      ask: `does the network ACL of ${subnet.SubnetId} allow the answer from ${addressText} back in (tcp, to port ${sourcePort})?`, noun: 'return traffic',
    }))
    const failed = steps.some(s => s.decision === 'deny' || s.decision === 'no-match' || s.decision === 'not-modelled')
    if (failed) {
      steps.push(skip('delivery', 'not evaluated: the path to the destination does not work'))
    } else {
      steps.push({
        phase: 'delivery', decision: 'allow',
        summary: `delivered to ${destination.host}`,
        detail: [`The destination is an AWS service endpoint: the request goes to the emulated service with source address ${publicIp}.`],
        evidence: [],
      })
      context = path
    }
  }

  const summary = summarize(steps.map(s => (s.decision === 'no-match' ? { ...s, decision: 'deny' as const } : s)))
  const outcome = summary.outcome
  const trace: Trace = {
    from, to: `${destination.host}:${destination.port}`, intent, steps, ...summary,
    observed: outcome === 'reached' ? 'reached' : outcome === 'unknown' ? 'unknown' : summary.cause === 'dns-resolver-disabled' ? 'dns-failure' : 'connect-timeout',
    ...(outcome === 'reached' ? { context } : {}),
  }
  if (summary.cause) {
    trace.hint = HINTS[summary.cause](destination)
  }
  return trace
}
