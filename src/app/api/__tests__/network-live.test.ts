import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'jpk-live-'))
process.env.JPK_DB_ROOT = root

/* eslint-disable @typescript-eslint/no-require-imports */
const { BadReachRequest, inspectReach, resolveSource } = require('@/app/api/network/live')
const { loadState, saveState } = require('@/app/api/db/ec2/state')

const account = '111111111111'
const region = 'eu-west-1'
const scope = { account, region }

beforeAll(() => mkdirSync(join(root, account), { recursive: true }))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// The default VPC of a new region: public subnets, a route to an internet gateway, an allow-all egress security group.
const defaults = () => {
  const state = loadState(scope)
  const subnet = Object.values<any>(state.subnets)[0]
  const group = Object.values<any>(state.securityGroups).find(g => g.VpcId === subnet.VpcId && g.GroupName === 'default')
  return { state, subnet, group }
}

describe('network inspection of the live state', () => {
  it('names the subnet and security group by id or Name tag and says what it filled in', () => {
    const { state, subnet, group } = defaults()
    subnet.Tags = [{ Key: 'Name', Value: 'front' }]
    saveState(scope, state)

    const byId = resolveSource(state, { subnet: subnet.SubnetId })
    expect(byId.source).toMatchObject({ subnetId: subnet.SubnetId, securityGroupIds: [group.GroupId] })
    expect(byId.assumptions).toHaveLength(2)
    expect(byId.assumptions.join(' ')).toContain(`the default group of ${subnet.VpcId}`)

    const byName = resolveSource(state, { subnet: 'front', securityGroups: ['default'], privateIp: subnet.CidrBlock.replace('0/20', '9') })
    expect(byName.source.subnetId).toBe(subnet.SubnetId)
    expect(byName.assumptions).toEqual([])
  })

  it('takes the source of an existing interface', () => {
    const { state, subnet, group } = defaults()
    state.networkInterfaces['eni-1'] = {
      NetworkInterfaceId: 'eni-1', SubnetId: subnet.SubnetId, VpcId: subnet.VpcId, PrivateIpAddress: subnet.CidrBlock.replace('0/20', '7'),
      Groups: [{ GroupId: group.GroupId }], Association: { PublicIp: '203.0.113.7' },
    }
    const { source, assumptions } = resolveSource(state, { networkInterfaceId: 'eni-1' })
    expect(source).toMatchObject({ subnetId: subnet.SubnetId, securityGroupIds: [group.GroupId], publicIp: '203.0.113.7', description: 'interface eni-1' })
    expect(assumptions).toEqual([])

    state.networkInterfaces['eni-2'] = { ...state.networkInterfaces['eni-1'], NetworkInterfaceId: 'eni-2', Groups: [] }
    expect(() => resolveSource(state, { networkInterfaceId: 'eni-2' })).toThrow(/managed by an AWS service/)
  })

  it.each([
    [{}, /Say where the connection starts/],
    [{ subnet: 'nope' }, /No subnet 'nope'/],
    [{ networkInterfaceId: 'eni-missing' }, /No network interface 'eni-missing'/],
  ])('rejects the source %j', (from, message) => {
    expect(() => resolveSource(defaults().state, from)).toThrow(message)
  })

  it('rejects an unknown security group and an address outside the subnet', () => {
    const { state, subnet } = defaults()
    expect(() => resolveSource(state, { subnet: subnet.SubnetId, securityGroups: ['sg-none'] })).toThrow(/No security group 'sg-none'/)
    expect(() => resolveSource(state, { subnet: subnet.SubnetId, privateIp: '8.8.8.8' })).toThrow(/not in subnet|is not in/)
    expect(() => resolveSource(state, { subnet: subnet.SubnetId, privateIp: '172.31.1.1', publicIp: 'banana' })).toThrow()
  })

  it('answers with the trace as data and as text', () => {
    const { subnet } = defaults()
    const without = inspectReach({ account, region, from: { subnet: subnet.SubnetId }, to: { host: 'sts.eu-west-1.amazonaws.com' } })
    // a default-VPC instance without a public address cannot reach the internet
    expect(without.trace.outcome).toBe('failed')
    expect(without.trace.cause).toBeDefined()
    expect(without.text).toContain('sts.eu-west-1.amazonaws.com')
    expect(without.assumptions.length).toBeGreaterThan(0)

    const withIp = inspectReach({ account, region, from: { subnet: subnet.SubnetId, publicIp: '203.0.113.50' }, to: { host: 'sts.eu-west-1.amazonaws.com', port: 443 } })
    expect(withIp.trace.outcome).toBe('reached')
    expect(withIp.trace.context).toBeDefined()
  })

  it('rejects requests that cannot be answered', () => {
    const ok = { account, region, from: { subnet: defaults().subnet.SubnetId }, to: { host: 'sts.eu-west-1.amazonaws.com' } }
    expect(() => inspectReach({ ...ok, account: '999999999999' })).toThrow(BadReachRequest)
    expect(() => inspectReach({ ...ok, region: 'mars-1' })).toThrow()
    expect(() => inspectReach({ ...ok, to: { host: '' } })).toThrow(/to\.host/)
    expect(() => inspectReach({ ...ok, to: { host: 'x', port: 70000 } })).toThrow(/not a port/)
  })
})
