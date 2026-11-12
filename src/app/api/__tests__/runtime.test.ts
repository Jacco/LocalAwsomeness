import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { createServer, type IncomingMessage, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'

const root = mkdtempSync(join(tmpdir(), 'jpk-runtime-'))
process.env.JPK_DB_ROOT = root

// Sessions are issued into the shared credentials store, which does not follow JPK_DB_ROOT: keep the tests out of db/.
jest.mock('@/app/api/data/credentials', () => ({
  issueSession: jest.fn((_account: string, _arn: string, userId: string) =>
    ({ keyId: 'ASIATESTKEY', secret: 'test-secret', sessionToken: 'test-token', expiration: Date.now() + 3600_000, userId })),
}))

/* eslint-disable @typescript-eslint/no-require-imports */
const { BadRunRequest, runInContext } = require('@/app/api/runtime/run')
const { loadState } = require('@/app/api/data/ec2/state')
const iam = require('@/app/api/data/iam')

const account = '111111111111'
const region = 'eu-west-1'
const STS = 'sts.eu-west-1.amazonaws.com'

// The simulator stands in for the emulated services: it records what reaches it. It lives in this process, so the
// runner must not block the event loop while the script calls it (the deadlock the design warns about).
let simulator: Server
let simulatorUrl: string
const received: { host?: string; path?: string; headers: IncomingMessage['headers'] }[] = []

const hasBoto3 = (() => {
  try {
    execFileSync('python3', ['-c', 'import boto3'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

beforeAll(async () => {
  mkdirSync(join(root, account), { recursive: true })
  simulator = createServer((request, response) => {
    received.push({ host: request.headers.host, path: request.url, headers: request.headers })
    response.setHeader('content-type', 'text/plain')
    response.end('the simulator answers')
  })
  await new Promise<void>(resolve => simulator.listen(0, '127.0.0.1', resolve))
  simulatorUrl = `http://127.0.0.1:${(simulator.address() as AddressInfo).port}`
  iam.createRole(account, {
    roleName: 'orders-fn-role',
    assumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
  })
  iam.createRole(account, {
    roleName: 'not-for-lambda',
    assumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
  })
})
afterAll(async () => {
  await new Promise(resolve => simulator.close(resolve))
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => { received.length = 0 })

// The subnets of the default VPC are public: a route to an internet gateway, an allow-all egress group.
const subnetId = (): string => Object.values<{ SubnetId: string }>(loadState({ account, region }).subnets)[0].SubnetId
const run = (code: string, extra: Record<string, unknown> = {}) =>
  runInContext({ account, region, from: { subnet: subnetId(), publicIp: '203.0.113.50' }, code, simulatorUrl, ...extra })

const GET = `
import urllib.request
try:
    print(urllib.request.urlopen('https://${STS}/', timeout=5).read().decode())
except Exception as e:
    print(type(e).__name__, e)
`

describe('running code in a context', () => {
  it('delivers an allowed connection to the simulator with the original host name', async () => {
    const result = await run(GET)

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('the simulator answers')
    expect(received).toHaveLength(1)
    expect(received[0].host).toBe(STS)
    expect(result.connections).toHaveLength(1)
    expect(result.connections[0]).toMatchObject({ host: STS, port: 443, scheme: 'https', verdict: 'allow', attempts: 1 })
    expect(result.connections[0].trace.context).toMatchObject({ sourceIp: '203.0.113.50', path: 'internet-gateway' })
    expect(result.text).toContain('REACHED')
  })

  it('makes a blocked connection a connect timeout and explains it', async () => {
    const result = await runInContext({ account, region, from: { subnet: subnetId() }, code: GET, simulatorUrl })

    expect(result.stdout).toMatch(/simulated: no-public-ip/)
    expect(received).toHaveLength(0)
    expect(result.connections[0]).toMatchObject({ verdict: 'deny', attempts: 1 })
    expect(result.connections[0].trace).toMatchObject({ outcome: 'failed', cause: 'no-public-ip', observed: 'connect-timeout' })
    // the code waited for its 5 s connect timeout, virtually
    expect(result.virtualSeconds).toBeGreaterThanOrEqual(5)
    expect(result.realSeconds).toBeLessThan(5)
    expect(result.assumptions.length).toBeGreaterThan(0)
    expect(result.text).toContain('Cause: no-public-ip')
  })

  it('uses the state at the time of each connection', async () => {
    const state = loadState({ account, region })
    const subnet = Object.values<{ SubnetId: string }>(state.subnets)[0]
    const result = await run(`
import urllib.request
def get():
    try:
        return urllib.request.urlopen('https://${STS}/', timeout=5).read().decode()
    except Exception as e:
        return type(e).__name__
print(get())
print(get())
`, { from: { subnet: subnet.SubnetId } })

    // no public address for either call: two identical failures are one record
    expect(result.connections).toHaveLength(1)
    expect(result.connections[0]).toMatchObject({ verdict: 'deny', attempts: 2 })
  })

  it('has a virtual clock: sleeping takes no real time but the code sees it', async () => {
    const result = await run(`
import time
start, mono = time.time(), time.monotonic()
time.sleep(3600)
print(round(time.time() - start), round(time.monotonic() - mono))
`)
    expect(result.stdout.trim()).toBe('3600 3600')
    expect(result.realSeconds).toBeLessThan(5)
  })

  it('refuses connections it cannot see and says so', async () => {
    const result = await run(`
import errno, socket
try:
    socket.create_connection(('93.184.216.34', 80), timeout=2)
except OSError as e:
    print('refused', e.errno == errno.ENETUNREACH)
`)
    expect(result.stdout.trim()).toBe('refused True')
    expect(result.unmodelled).toEqual([expect.objectContaining({ host: '93.184.216.34', port: 80 })])
    expect(result.text).toContain('the shim cannot see')
  })

  it('does not hand the machine environment to the code', async () => {
    const result = await run(`
import os
print(sorted(k for k in os.environ if k.startswith('AWS')))
print(os.environ['AWS_REGION'])
`)
    expect(result.stdout).toContain("['AWS_CONFIG_FILE', 'AWS_DEFAULT_REGION', 'AWS_EC2_METADATA_DISABLED', 'AWS_REGION', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_STS_REGIONAL_ENDPOINTS']")
    expect(result.stdout).toContain(region)
  })

  it('reports the exit code, the output and the traceback of a failing script', async () => {
    const result = await run('print("before")\nraise ValueError("boom")')
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('before\n')
    expect(result.stderr).toContain('ValueError: boom')
    expect((await run('import sys; sys.exit(7)')).exitCode).toBe(7)
  })

  it('kills a script that runs past the wall-clock limit', async () => {
    const result = await run('while True:\n    pass', { timeoutSeconds: 1 })
    expect(result.timedOut).toBe(true)
  })

  describe('with the credentials of an execution role', () => {
    const script = `
import boto3
from botocore.config import Config
try:
    print(boto3.client('sts', config=Config(connect_timeout=2)).get_caller_identity())
except Exception as e:
    print(type(e).__name__)
`
    it('gives the code a session of the role, signed for the real service name', async () => {
      const result = await run(script, { role: 'orders-fn-role', sessionName: 'orders-fn' })

      expect(result.identity).toBe(`arn:aws:sts::${account}:assumed-role/orders-fn-role/orders-fn`)
      if (!hasBoto3) {
        return
      }
      expect(received).toHaveLength(1)
      expect(received[0].host).toBe(STS)
      expect(received[0].headers.authorization).toContain(`/${region}/sts/aws4_request`)
      expect(received[0].headers['x-amz-security-token']).toBeDefined()
    })

    it('has no credentials without a role', async () => {
      if (!hasBoto3) {
        return
      }
      const result = await run(script)
      expect(result.stdout.trim()).toBe('NoCredentialsError')
      expect(received).toHaveLength(0)
    })

    it('shows a retrying SDK as one record and takes no real time for the back-off', async () => {
      if (!hasBoto3) {
        return
      }
      const result = await runInContext({ account, region, from: { subnet: subnetId() }, role: 'orders-fn-role', code: script, simulatorUrl })

      expect(result.stdout.trim()).toBe('ConnectTimeoutError')
      expect(result.connections).toHaveLength(1)
      expect(result.connections[0].attempts).toBeGreaterThan(1)
      expect(result.virtualSeconds).toBeGreaterThan(result.connections[0].attempts * 2)
      expect(result.realSeconds).toBeLessThan(10)
    })
  })

  it.each([
    [{ role: 'nope' }, /No role 'nope'/],
    [{ role: 'not-for-lambda' }, /does not allow lambda.amazonaws.com/],
    [{ code: '' }, /No code/],
    [{ from: { subnet: 'nope' } }, /No subnet 'nope'/],
    [{ account: '999999999999' }, /Unknown account/],
  ])('refuses the request %j', async (extra, message) => {
    await expect(run('print(1)', extra)).rejects.toThrow(message)
    await expect(run('print(1)', extra)).rejects.toBeInstanceOf(BadRunRequest)
  })
})
