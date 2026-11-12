import type { Ec2State } from '@/app/api/data/ec2/state'
import { addNetworkAcl, addSecurityGroup, createSubnet, createVpc, securityGroupRule } from '@/app/api/data/ec2/state'
import { effectiveRouteState, lookupRoute, routeTableFor } from '@/app/analysis/network/routes'
import { reachPublicService, servicePublicAddress, type Source } from '@/app/analysis/network/reach'
import { renderTrace, type Trace } from '@/app/analysis/network/trace'

// The network model is pure: these tests build the EC2 state by hand and ask whether a Lambda-like source can call a
// public service. The four variants A to D are the walking skeleton scenario (docs/walking-skeleton.md).

const scope = { account: '123456789012', region: 'eu-west-1' }
const zone = { name: 'eu-west-1a', id: 'euw1-az1' }
const HOST = 'sts.eu-west-1.amazonaws.com'
const NAT_EIP = '203.0.113.10'

function emptyState(): Ec2State {
  return {
    defaultDhcpOptionsId: 'dopt-0', vpcs: {}, vpcAttributes: {}, subnets: {}, routeTables: {}, networkAcls: {}, securityGroups: {},
    securityGroupRules: {}, internetGateways: {}, dhcpOptions: {}, networkInterfaces: {}, natGateways: {}, addresses: {},
  }
}

const tag = (Name: string) => [{ Key: 'Name', Value: Name }]

// A VPC with a public subnet (route table with a route to an internet gateway, a NAT gateway with an Elastic IP in it) and
// a private subnet that, as created, only has the main route table with the local route: variant A.
function build() {
  const state = emptyState()
  const vpc = createVpc(state, scope, { cidr: '10.0.0.0/16', tags: tag('main') })
  const vpcId: string = vpc.VpcId
  const publicSubnet = createSubnet(state, scope, { vpcId, cidr: '10.0.1.0/24', zone, tags: tag('public') }).SubnetId as string
  const privateSubnet = createSubnet(state, scope, { vpcId, cidr: '10.0.2.0/24', zone, tags: tag('private') }).SubnetId as string

  state.internetGateways['igw-1'] = { InternetGatewayId: 'igw-1', Attachments: [{ VpcId: vpcId, State: 'available' }], Tags: [] }
  const addTable = (id: string, subnetId: string, routes: Record<string, unknown>[], name: string) => {
    state.routeTables[id] = {
      RouteTableId: id, VpcId: vpcId, Tags: tag(name), PropagatingVgws: [],
      Associations: [{ RouteTableAssociationId: `rtbassoc-${id}`, RouteTableId: id, SubnetId: subnetId, AssociationState: { State: 'associated' } }],
      Routes: [{ DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local', State: 'active' }, ...routes],
    }
  }
  addTable('rtb-public', publicSubnet, [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1', State: 'active' }], 'public')
  state.addresses['eipalloc-1'] = { AllocationId: 'eipalloc-1', PublicIp: NAT_EIP, Tags: [] }
  state.natGateways['nat-1'] = {
    NatGatewayId: 'nat-1', VpcId: vpcId, SubnetId: publicSubnet, State: 'available', ConnectivityType: 'public', Tags: tag('nat'),
    NatGatewayAddresses: [{ AllocationId: 'eipalloc-1', PublicIp: NAT_EIP, PrivateIp: '10.0.1.5' }],
  }

  const group = addSecurityGroup(state, scope, { vpcId, name: 'fn', description: 'function', tags: tag('fn') })
  const allowAll = securityGroupRule(scope, group.GroupId, true, { CidrIpv4: '0.0.0.0/0' })
  state.securityGroupRules[allowAll.SecurityGroupRuleId] = allowAll

  const source: Source = { description: 'lambda orders-fn', subnetId: privateSubnet, securityGroupIds: [group.GroupId], privateIp: '10.0.2.37' }
  return {
    state, vpcId, publicSubnet, privateSubnet, group: group.GroupId as string, allowAll: allowAll.SecurityGroupRuleId as string, source,
    // variant B: the private subnet gets its own route table that sends internet traffic to the NAT gateway
    routePrivateThroughNat: (target: Record<string, unknown> = { NatGatewayId: 'nat-1' }) =>
      addTable('rtb-private', privateSubnet, [{ DestinationCidrBlock: '0.0.0.0/0', ...target, State: 'active' }], 'private'),
    addTable,
  }
}

const reach = (env: ReturnType<typeof build>, options?: { sourcePort?: number }, source = env.source, host = HOST): Trace =>
  reachPublicService(env.state, source, { host, port: 443 }, options)
const phases = (trace: Trace) => trace.steps.map(s => `${s.phase}:${s.decision}`)
const step = (trace: Trace, phase: string) => trace.steps.find(s => s.phase === phase)!

// Replaces the ACL of a subnet by a custom one with the given entries (plus the final deny rules).
function customAcl(env: ReturnType<typeof build>, subnetId: string, entries: Record<string, unknown>[]) {
  const acl = addNetworkAcl(env.state, scope, { vpcId: env.vpcId, tags: tag('custom') })
  acl.Entries.push(...entries)
  for (const other of Object.values(env.state.networkAcls)) {
    other.Associations = other.Associations.filter((a: { SubnetId: string }) => a.SubnetId !== subnetId)
  }
  acl.Associations.push({ NetworkAclAssociationId: 'aclassoc-custom', NetworkAclId: acl.NetworkAclId, SubnetId: subnetId })
  return acl.NetworkAclId as string
}
const entry = (RuleNumber: number, RuleAction: string, Egress: boolean, CidrBlock: string, port?: [number, number]) =>
  ({ RuleNumber, RuleAction, Egress, CidrBlock, Protocol: port ? '6' : '-1', ...(port ? { PortRange: { From: port[0], To: port[1] } } : {}) })

describe('network model: the four scenario variants', () => {
  it('A: a private subnet with only the local route has no way out', () => {
    const env = build()
    const trace = reach(env)

    expect(trace).toMatchObject({ outcome: 'failed', failedAt: 'route', cause: 'no-route', observed: 'connect-timeout' })
    expect(phases(trace)).toEqual([
      'dns:allow', 'security-group-out:allow', 'nacl-out:allow', 'route:no-match', 'nacl-in:allow', 'delivery:not-evaluated',
    ])
    expect(trace.problems).toHaveLength(1)
    const route = step(trace, 'route')
    expect(route.summary).toMatch(/^no route of rtb-[0-9a-f]+ matches 198\.51\.100\.\d+$/)
    expect(route.detail.join(' ')).toContain(`main route table of ${env.vpcId}`)
    expect(route.detail.join(' ')).toContain('has 10.0.0.0/16 -> local')
    expect(trace.hint).toContain('NAT gateway')
    expect(trace.context).toBeUndefined()
  })

  it('B: a route to a NAT gateway in a public subnet works, and the source is the NAT gateway Elastic IP', () => {
    const env = build()
    env.routePrivateThroughNat()
    const trace = reach(env)

    expect(trace).toMatchObject({
      outcome: 'reached', observed: 'reached', problems: [],
      context: { sourceIp: NAT_EIP, path: 'nat-gateway', natGatewayId: 'nat-1' },
    })
    expect(phases(trace)).toEqual([
      'dns:allow', 'security-group-out:allow', 'nacl-out:allow', 'route:allow', 'nat-gateway:allow', 'internet-gateway:allow', 'nacl-in:allow', 'delivery:allow',
    ])
    expect(step(trace, 'route').summary).toBe('route 0.0.0.0/0 -> nat-1 sends the packet to nat-1')
    expect(step(trace, 'nat-gateway').summary).toContain(NAT_EIP)
    expect(step(trace, 'internet-gateway').summary).toBe(`igw-1 translates the source to ${NAT_EIP}`)
  })

  it('C: without an egress rule for 443 the security group drops the packet, and the trace lists the rules it has', () => {
    const env = build()
    env.routePrivateThroughNat()
    delete env.state.securityGroupRules[env.allowAll]
    const only = securityGroupRule(scope, env.group, true, { CidrIpv4: '10.0.0.0/8', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 })
    env.state.securityGroupRules[only.SecurityGroupRuleId] = only
    const trace = reach(env)

    expect(trace).toMatchObject({ outcome: 'failed', failedAt: 'security-group-out', cause: 'security-group-blocks', observed: 'connect-timeout' })
    expect(trace.problems).toHaveLength(1)
    const sg = step(trace, 'security-group-out')
    expect(sg.summary).toMatch(/no egress rule of sg-[0-9a-f]+ allows tcp\/443 to 198\.51\.100\.\d+/)
    expect(sg.detail.join(' ')).toContain('egress rules: tcp 443 to 10.0.0.0/8')
    expect(sg.evidence[0]).toMatchObject({ kind: 'security-group', id: env.group, name: 'fn' })
    expect(trace.hint).toBe('add an egress rule for tcp/443 to the destination to a security group of the interface')
    // everything else is fine, so only this step fails
    expect(phases(trace).filter(p => p.endsWith(':deny'))).toEqual(['security-group-out:deny'])
  })

  it.each([
    ['the NAT gateway is gone', (env: ReturnType<typeof build>) => { delete env.state.natGateways['nat-1'] }],
    ['the NAT gateway is deleted', (env: ReturnType<typeof build>) => { env.state.natGateways['nat-1'].State = 'deleted' }],
  ])('D: when %s the route is a blackhole', (_name, remove) => {
    const env = build()
    env.routePrivateThroughNat()
    remove(env)
    const trace = reach(env)

    expect(trace).toMatchObject({ outcome: 'failed', failedAt: 'route', cause: 'blackhole-route', observed: 'connect-timeout' })
    expect(step(trace, 'route').summary).toBe('route 0.0.0.0/0 -> nat-1 is a blackhole: its target does not exist')
    expect(trace.steps.some(s => s.phase === 'nat-gateway')).toBe(false)
    expect(step(trace, 'delivery').decision).toBe('not-evaluated')
  })
})

describe('network model: the internet gateway path', () => {
  it('a public subnet reaches the internet directly when the interface has a public address', () => {
    const env = build()
    const source = { ...env.source, subnetId: env.publicSubnet, privateIp: '10.0.1.20', publicIp: '203.0.113.99' }
    const trace = reach(env, undefined, source)
    expect(trace).toMatchObject({ outcome: 'reached', context: { sourceIp: '203.0.113.99', path: 'internet-gateway' } })
    expect(step(trace, 'internet-gateway').summary).toBe('igw-1 translates the source to 203.0.113.99')
  })

  it('an internet gateway cannot be used without a public address', () => {
    const env = build()
    const trace = reach(env, undefined, { ...env.source, subnetId: env.publicSubnet, privateIp: '10.0.1.20' })
    expect(trace).toMatchObject({ outcome: 'failed', failedAt: 'internet-gateway', cause: 'no-public-ip', observed: 'connect-timeout' })
    expect(trace.hint).toContain('Elastic IP')
  })

  it('a detached internet gateway makes the route a blackhole', () => {
    const env = build()
    env.state.internetGateways['igw-1'].Attachments = []
    const trace = reach(env, undefined, { ...env.source, subnetId: env.publicSubnet, privateIp: '10.0.1.20', publicIp: '203.0.113.99' })
    expect(trace).toMatchObject({ outcome: 'failed', failedAt: 'route', cause: 'blackhole-route' })
    expect(step(trace, 'route').detail.join(' ')).toContain('not attached to this VPC or does not exist')
  })
})

describe('network model: the NAT gateway', () => {
  it('needs a route to an internet gateway in its own subnet', () => {
    const env = build()
    env.routePrivateThroughNat()
    // move the NAT gateway to the private subnet: its table has no internet route
    env.state.natGateways['nat-1'].SubnetId = env.privateSubnet
    const trace = reach(env)
    expect(trace).toMatchObject({ outcome: 'failed', failedAt: 'nat-gateway', cause: 'nat-without-internet-route' })
    expect(step(trace, 'nat-gateway').summary).toContain('the route table of its subnet')
    expect(trace.hint).toBe('the subnet of the NAT gateway needs a route to an internet gateway')
  })

  it('must be available and public', () => {
    const pending = build()
    pending.routePrivateThroughNat()
    pending.state.natGateways['nat-1'].State = 'pending'
    expect(reach(pending)).toMatchObject({ failedAt: 'nat-gateway', cause: 'nat-gateway-unavailable' })

    const priv = build()
    priv.routePrivateThroughNat()
    priv.state.natGateways['nat-1'].ConnectivityType = 'private'
    expect(reach(priv)).toMatchObject({ failedAt: 'nat-gateway', cause: 'nat-gateway-private' })
  })

  it('is subject to the network ACL of its own subnet', () => {
    const env = build()
    env.routePrivateThroughNat()
    customAcl(env, env.publicSubnet, [entry(100, 'deny', false, '10.0.2.0/24'), entry(200, 'allow', false, '0.0.0.0/0'), entry(200, 'allow', true, '0.0.0.0/0')])
    const trace = reach(env)
    expect(trace).toMatchObject({ outcome: 'failed', failedAt: 'nat-gateway', cause: 'nacl-blocks' })
    expect(step(trace, 'nat-gateway').summary).toContain('blocks the packet from 10.0.2.37 entering the subnet of the NAT gateway')
  })
})

describe('network model: network ACLs', () => {
  it('an outbound deny rule is the first match and blocks the packet', () => {
    const env = build()
    env.routePrivateThroughNat()
    const acl = customAcl(env, env.privateSubnet, [entry(90, 'deny', true, '0.0.0.0/0', [443, 443]), entry(100, 'allow', true, '0.0.0.0/0'), entry(100, 'allow', false, '0.0.0.0/0')])
    const trace = reach(env)
    expect(trace).toMatchObject({ outcome: 'failed', failedAt: 'nacl-out', cause: 'nacl-blocks' })
    const nacl = step(trace, 'nacl-out')
    expect(nacl.summary).toBe(`outbound denied by ${acl} rule 90 deny tcp 443-443 to 0.0.0.0/0`)
    expect(nacl.detail.join(' ')).toContain('rule 90 deny tcp 443-443 to 0.0.0.0/0; rule 100 allow all traffic to 0.0.0.0/0')
  })

  it('is stateless: the answer needs an inbound rule for the client port, which the shim reports', () => {
    const env = build()
    env.routePrivateThroughNat()
    customAcl(env, env.privateSubnet, [entry(100, 'allow', true, '0.0.0.0/0'), entry(100, 'allow', false, '0.0.0.0/0', [1024, 2047])])

    const blocked = reach(env, { sourcePort: 49152 })
    expect(blocked).toMatchObject({ outcome: 'failed', failedAt: 'nacl-in', cause: 'nacl-blocks' })
    expect(step(blocked, 'nacl-in').summary).toMatch(/return traffic denied by acl-[0-9a-f]+ rule 32767 deny all traffic from 0\.0\.0\.0\/0/)
    expect(step(blocked, 'nacl-in').detail.join(' ')).toContain('the final rule (32767) denies it')
    expect(blocked.hint).toContain('return traffic needs a rule in the other direction too')
    // the packet itself got through every other step
    expect(phases(blocked).filter(p => p.endsWith(':deny'))).toEqual(['nacl-in:deny'])

    expect(reach(env, { sourcePort: 1500 }).outcome).toBe('reached')
  })

  it('evaluates rules in number order, whatever order they are stored in', () => {
    const env = build()
    env.routePrivateThroughNat()
    customAcl(env, env.privateSubnet, [entry(300, 'deny', true, '0.0.0.0/0'), entry(100, 'allow', true, '0.0.0.0/0'), entry(100, 'allow', false, '0.0.0.0/0')])
    expect(reach(env).outcome).toBe('reached')
  })
})

describe('network model: route lookup', () => {
  it('uses the most specific route, and says which less specific ones it passed over', () => {
    const env = build()
    const address = servicePublicAddress(HOST)
    env.routePrivateThroughNat()
    env.state.routeTables['rtb-private'].Routes.push({ DestinationCidrBlock: `${address.split('.').slice(0, 3).join('.')}.0/24`, NatGatewayId: 'nat-gone', State: 'active' })
    const trace = reach(env)
    expect(trace).toMatchObject({ failedAt: 'route', cause: 'blackhole-route' })
    expect(step(trace, 'route').detail.join(' ')).toContain('(less specific: 0.0.0.0/0 -> nat-1)')
  })

  it('uses the explicit association of a subnet, else the main route table', () => {
    const env = build()
    const subnet = env.state.subnets[env.privateSubnet]
    expect(routeTableFor(env.state, subnet).how).toBe('main')
    env.routePrivateThroughNat()
    expect(routeTableFor(env.state, subnet)).toMatchObject({ how: 'explicit', table: { RouteTableId: 'rtb-private' } })
    expect(lookupRoute(env.state.routeTables['rtb-private'], 0x08080808).match).toMatchObject({ DestinationCidrBlock: '0.0.0.0/0' })
  })

  it('derives the state of a route from its target', () => {
    const env = build()
    const route = (fields: Record<string, unknown>) => ({ DestinationCidrBlock: '0.0.0.0/0', State: 'active', Tags: [], ...fields })
    expect(effectiveRouteState(env.state, env.vpcId, route({ GatewayId: 'local' }))).toBe('active')
    expect(effectiveRouteState(env.state, env.vpcId, route({ GatewayId: 'igw-1' }))).toBe('active')
    expect(effectiveRouteState(env.state, env.vpcId, route({ GatewayId: 'igw-2' }))).toBe('blackhole')
    // an internet gateway attached to another VPC does not count
    env.state.internetGateways['igw-1'].Attachments = [{ VpcId: 'vpc-other', State: 'available' }]
    expect(effectiveRouteState(env.state, env.vpcId, route({ GatewayId: 'igw-1' }))).toBe('blackhole')
    expect(effectiveRouteState(env.state, env.vpcId, route({ NatGatewayId: 'nat-1' }))).toBe('active')
    env.state.natGateways['nat-1'].State = 'deleting'
    expect(effectiveRouteState(env.state, env.vpcId, route({ NatGatewayId: 'nat-1' }))).toBe('blackhole')
    // targets that are not modelled keep their stored state
    expect(effectiveRouteState(env.state, env.vpcId, route({ VpcPeeringConnectionId: 'pcx-1' }))).toBe('active')
    expect(effectiveRouteState(env.state, env.vpcId, route({ VpcPeeringConnectionId: 'pcx-1', State: 'blackhole' }))).toBe('blackhole')
  })
})

describe('network model: names and what is not modelled', () => {
  it('fails at the name when the VPC resolver is off, and evaluates nothing else', () => {
    const env = build()
    env.state.vpcAttributes[env.vpcId].enableDnsSupport = false
    const trace = reach(env)
    expect(trace).toMatchObject({ outcome: 'failed', failedAt: 'dns', cause: 'dns-resolver-disabled', observed: 'dns-failure' })
    expect(phases(trace)).toEqual(['dns:deny', 'security-group-out:not-evaluated', 'nacl-out:not-evaluated', 'route:not-evaluated', 'nacl-in:not-evaluated', 'delivery:not-evaluated'])
    expect(trace.hint).toContain('enableDnsSupport')
  })

  it('needs no lookup for an address', () => {
    const env = build()
    env.routePrivateThroughNat()
    env.state.vpcAttributes[env.vpcId].enableDnsSupport = false
    const trace = reach(env, undefined, env.source, '8.8.8.8')
    expect(trace.outcome).toBe('reached')
    expect(step(trace, 'dns').summary).toBe('8.8.8.8 is an address, no lookup is needed')
  })

  it('stand-in service addresses are stable and in the documentation range', () => {
    expect(servicePublicAddress(HOST)).toBe(servicePublicAddress(HOST.toUpperCase()))
    for (const host of ['a.amazonaws.com', 'b.amazonaws.com', HOST]) {
      expect(servicePublicAddress(host)).toMatch(/^198\.51\.100\.\d{1,3}$/)
    }
  })

  it('reports unknown, not allowed or denied, for a destination inside the VPC and for targets that are not modelled', () => {
    const env = build()
    const inside = reach(env, undefined, env.source, '10.0.1.99')
    expect(inside).toMatchObject({ outcome: 'unknown', observed: 'unknown' })
    expect(inside.cause).toBeUndefined()
    expect(step(inside, 'route')).toMatchObject({ decision: 'not-modelled', cause: 'not-modelled' })
    expect(step(inside, 'route').summary).toContain('destinations inside a VPC are not modelled yet')

    env.routePrivateThroughNat({ VpcPeeringConnectionId: 'pcx-1' })
    const peering = reach(env)
    expect(peering.outcome).toBe('unknown')
    expect(step(peering, 'route').summary).toBe('route target pcx-1 (VpcPeeringConnectionId) is not modelled yet')
  })

  it('a failure outranks a part that is not modelled', () => {
    const env = build()
    env.routePrivateThroughNat({ VpcPeeringConnectionId: 'pcx-1' })
    delete env.state.securityGroupRules[env.allowAll]
    expect(reach(env)).toMatchObject({ outcome: 'failed', failedAt: 'security-group-out' })
  })
})

describe('network model: every problem is reported, the first in packet order is the cause', () => {
  it('lists the security group and the missing route together', () => {
    const env = build()
    delete env.state.securityGroupRules[env.allowAll]
    const trace = reach(env)
    expect(trace).toMatchObject({ failedAt: 'security-group-out', cause: 'security-group-blocks' })
    expect(trace.problems.map(p => p.cause)).toEqual(['security-group-blocks', 'no-route'])
    expect(renderTrace(trace)).toContain('All problems found: security-group-out (security-group-blocks), route (no-route)')
  })
})

describe('trace rendering', () => {
  it('renders the failing variant A in the documented form', () => {
    const env = build()
    const text = renderTrace(reach(env))
    const lines = text.split('\n')
    expect(lines[0]).toBe(`lambda orders-fn (${env.privateSubnet} (private), ${env.group}) -> ${HOST}:443   FAILED at route`)
    expect(lines[1]).toBe(`  HTTPS to ${HOST}:443`)
    expect(text).toMatch(/\n {2}4 {2}route {14}\[none \] no route of rtb-[0-9a-f]+ matches 198\.51\.100\.\d+\n/)
    expect(text).toContain('  Cause: no-route')
    expect(text).toContain('  Hint: add a route for the destination')
    expect(lines.at(-1)).toBe('  What the code sees: a connect timeout (a dropped packet gets no answer, so the client waits for its connect timeout)')
    expect(text).toContain('[skip ] not evaluated: the path to the destination does not work')
  })

  it('renders the request context of a successful call', () => {
    const env = build()
    env.routePrivateThroughNat()
    const text = renderTrace(reach(env))
    expect(text).toContain('REACHED')
    expect(text).toContain(`Request context: source ${NAT_EIP} via nat-gateway nat-1`)
    expect(text).not.toContain('Cause:')
    expect(text.split('\n').at(-1)).toBe('  What the code sees: the call succeeds')
  })
})
