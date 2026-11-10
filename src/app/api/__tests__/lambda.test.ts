import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { createServer, type IncomingMessage, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'jpk-lambda-'))
process.env.JPK_DB_ROOT = root

// Every invocation starts a Python process.
jest.setTimeout(30000)

// Sessions are issued into the shared credentials store, which does not follow JPK_DB_ROOT: keep the tests out of db/.
jest.mock('@/app/api/db/credentials', () => ({
  issueSession: jest.fn((_account: string, _arn: string, userId: string) =>
    ({ keyId: 'ASIATESTKEY', secret: 'test-secret', sessionToken: 'test-token', expiration: Date.now() + 3600_000, userId })),
}))

/* eslint-disable @typescript-eslint/no-require-imports */
const functionsRoute = require('@/app/api/lambda/2015-03-31/functions/route')
const functionRoute = require('@/app/api/lambda/2015-03-31/functions/[name]/route')
const configurationRoute = require('@/app/api/lambda/2015-03-31/functions/[name]/configuration/route')
const invocationsRoute = require('@/app/api/lambda/2015-03-31/functions/[name]/invocations/route')
const inspectRoute = require('@/app/api/lambda/inspect/route')
const iam = require('@/app/api/db/iam')
const { addSecurityGroup, createSubnet, createVpc, loadState, saveState, securityGroupRule } = require('@/app/api/db/ec2/state')
const { QUOTAS, setQuota } = require('@/app/api/quotas')
const { availableAddressCount } = require('@/app/api/db/ec2/interfaces')

const account = '111111111111'
const region = 'eu-west-1'
const scope = { account, region }
const ROLE = `arn:aws:iam::${account}:role/fn-role`
const STS = 'sts.eu-west-1.amazonaws.com'

// The simulator stands in for the emulated services and records what reaches it (the function runs in a subprocess that
// calls back into this process).
let simulator: Server
const received: { host?: string; headers: IncomingMessage['headers'] }[] = []

beforeAll(async () => {
  mkdirSync(join(root, account), { recursive: true })
  simulator = createServer((request, response) => {
    received.push({ host: request.headers.host, headers: request.headers })
    response.end('the simulator answers')
  })
  await new Promise<void>(resolve => simulator.listen(0, '127.0.0.1', resolve))
  process.env.JPK_SIMULATOR_URL = `http://127.0.0.1:${(simulator.address() as AddressInfo).port}`
  const trust = (service: string) => ({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole' }] })
  iam.createRole(account, { roleName: 'fn-role', assumeRolePolicyDocument: trust('lambda.amazonaws.com') })
  iam.createRole(account, { roleName: 'ec2-role', assumeRolePolicyDocument: trust('ec2.amazonaws.com') })
})
afterAll(async () => {
  await new Promise(resolve => simulator.close(resolve))
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => { received.length = 0 })

const headers = () => ({
  'x-aws-principal': `arn:aws:sts::${account}:assumed-role/admin/session`,
  'x-aws-userid': 'AROAEXAMPLE',
  authorization: `AWS4-HMAC-SHA256 Credential=KEY/20250101/${region}/lambda/aws4_request, SignedHeaders=host, Signature=abc`,
})

interface Answer {
  status: number
  body: any
  text: string
  headers: Headers
}

async function send(handler: (request: Request) => Promise<Response>, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Answer> {
  const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  const response = await handler(new Request(`http://localhost${path}`, { method, body: raw, headers: { ...headers(), ...extra } }))
  const text = await response.text()
  let parsed: any
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  return { status: response.status, body: parsed, text, headers: response.headers }
}

const create = (body: Record<string, unknown>) => send(functionsRoute.POST, 'POST', '/2015-03-31/functions', body)
const invoke = (name: string, payload: unknown = {}, extra: Record<string, string> = {}) =>
  send(invocationsRoute.POST, 'POST', `/2015-03-31/functions/${name}/invocations`, typeof payload === 'string' ? payload : JSON.stringify(payload), extra)
const remove = (name: string) => send(functionRoute.DELETE, 'DELETE', `/2015-03-31/functions/${name}`)
const errorOf = (answer: Answer) => ({ type: answer.headers.get('x-amzn-errortype'), message: answer.body?.Message as string })

// A deployment package with the given files, made by Python's zipfile (the same format Lambda unpacks).
function zip(files: Record<string, string>): string {
  return execFileSync('python3', ['-c', `
import base64, io, json, sys, zipfile
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w') as archive:
    for name, content in json.loads(sys.argv[1]).items():
        archive.writestr(name, content)
sys.stdout.write(base64.b64encode(buffer.getvalue()).decode())
`, JSON.stringify(files)]).toString()
}

const source = (body: string) => zip({ 'index.py': `import json, time, os, logging\n${body}\n` })
const HELLO = source('def handler(event, context):\n    print("hello from", context.function_name)\n    return {"echo": event, "memory": context.memory_limit_in_mb}')
const fn = (name: string, code: string, extra: Record<string, unknown> = {}) =>
  create({ FunctionName: name, Runtime: 'python3.12', Role: ROLE, Handler: 'index.handler', Code: { ZipFile: code }, ...extra })

const ec2 = () => loadState(scope)
const lambdaInterfaces = () => Object.values<any>(ec2().networkInterfaces).filter(eni => eni.InterfaceType === 'lambda')
const defaultSubnet = () => Object.values<any>(ec2().subnets)[0]

describe('Lambda control plane', () => {
  it('creates, reads, lists and deletes a function', async () => {
    const created = await fn('orders', HELLO, { Description: 'orders', Tags: { team: 'a' }, Environment: { Variables: { STAGE: 'test' } } })

    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      FunctionName: 'orders', FunctionArn: `arn:aws:lambda:${region}:${account}:function:orders`, Runtime: 'python3.12', Role: ROLE,
      Handler: 'index.handler', Timeout: 3, MemorySize: 128, Version: '$LATEST', State: 'Active', LastUpdateStatus: 'Successful',
      PackageType: 'Zip', Environment: { Variables: { STAGE: 'test' } }, Description: 'orders',
    })
    expect(created.body.VpcConfig).toBeUndefined()
    expect(created.body.CodeSize).toBeGreaterThan(0)
    expect(created.body.CodeSha256).toMatch(/^[A-Za-z0-9+/]{43}=$/)
    expect(created.body.LastModified).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+0000$/)

    const got = await send(functionRoute.GET, 'GET', '/2015-03-31/functions/orders')
    expect(got.status).toBe(200)
    expect(got.body.Configuration.FunctionName).toBe('orders')
    expect(got.body.Code.RepositoryType).toBe('S3')
    expect(got.body.Tags).toEqual({ team: 'a' })
    expect((await send(configurationRoute.GET, 'GET', '/2015-03-31/functions/orders/configuration')).body.FunctionName).toBe('orders')
    // by full ARN, as the console and the CLI do
    const arn = encodeURIComponent(created.body.FunctionArn)
    expect((await send(functionRoute.GET, 'GET', `/2015-03-31/functions/${arn}`)).status).toBe(200)

    await fn('billing', HELLO)
    expect((await send(functionsRoute.GET, 'GET', '/2015-03-31/functions/')).body.Functions.map((f: any) => f.FunctionName)).toEqual(['billing', 'orders'])
    const page = await send(functionsRoute.GET, 'GET', '/2015-03-31/functions?MaxItems=1')
    expect(page.body.Functions).toHaveLength(1)
    expect(page.body.NextMarker).toBe('billing')
    expect((await send(functionsRoute.GET, 'GET', `/2015-03-31/functions?MaxItems=1&Marker=billing`)).body.Functions[0].FunctionName).toBe('orders')

    expect((await remove('orders')).status).toBe(204)
    expect(errorOf(await send(functionRoute.GET, 'GET', '/2015-03-31/functions/orders'))).toEqual({
      type: 'ResourceNotFoundException', message: `Function not found: arn:aws:lambda:${region}:${account}:function:orders`,
    })
    expect(errorOf(await remove('orders')).type).toBe('ResourceNotFoundException')
    await remove('billing')
  })

  it.each([
    [{ FunctionName: 'bad name!' }, 'ValidationException', /functionName/],
    [{ Role: 'not-an-arn' }, 'ValidationException', /at 'role'/],
    [{ Role: `arn:aws:iam::${account}:role/missing` }, 'InvalidParameterValueException', /cannot be assumed by Lambda/],
    [{ Role: `arn:aws:iam::${account}:role/ec2-role` }, 'InvalidParameterValueException', /cannot be assumed by Lambda/],
    [{ Runtime: 'nodejs20.x' }, 'InvalidParameterValueException', /Runtime 'nodejs20.x' is not supported/],
    [{ Runtime: undefined }, 'InvalidParameterValueException', /Runtime and Handler are required/],
    [{ Timeout: 901 }, 'ValidationException', /timeout.*less than or equal to 900/],
    [{ Timeout: 0 }, 'ValidationException', /timeout.*greater than or equal to 1/],
    [{ MemorySize: 64 }, 'ValidationException', /memorySize.*greater than or equal to 128/],
    [{ MemorySize: 10241 }, 'ValidationException', /memorySize.*less than or equal to 10240/],
    [{ Environment: { Variables: { AWS_REGION: 'x', _HANDLER: 'y' } } }, 'InvalidParameterValueException', /reserved keys.*AWS_REGION,_HANDLER/],
    [{ Environment: { Variables: { BIG: 'x'.repeat(4097) } } }, 'InvalidParameterValueException', /exceeded the 4KB limit/],
    [{ Code: { S3Bucket: 'b', S3Key: 'k' } }, 'InvalidParameterValueException', /Code.S3Bucket is not supported/],
    [{ Code: { ZipFile: Buffer.from('not a zip file').toString('base64') } }, 'InvalidParameterValueException', /Could not unzip/],
    [{ PackageType: 'Image' }, 'InvalidParameterValueException', /PackageType 'Image' is not supported/],
    [{ Layers: ['arn:aws:lambda:eu-west-1:123456789012:layer:x:1'] }, 'InvalidParameterValueException', /Parameter 'Layers' is not supported/],
    [{ DeadLetterConfig: { TargetArn: 'arn:aws:sns:eu-west-1:123456789012:t' } }, 'InvalidParameterValueException', /Parameter 'DeadLetterConfig' is not supported/],
    [{ Publish: true }, 'InvalidParameterValueException', /Parameter 'Publish' is not supported/],
  ])('refuses %j', async (override, type, message) => {
    const body = { FunctionName: 'refused', Runtime: 'python3.12', Role: ROLE, Handler: 'index.handler', Code: { ZipFile: HELLO }, ...override }
    const answer = await create(body)
    expect(errorOf(answer)).toEqual({ type, message: expect.stringMatching(message) })
    expect(answer.status).toBe(400)
    expect((await send(functionRoute.GET, 'GET', '/2015-03-31/functions/refused')).status).toBe(404)
  })

  it('answers the reads that Terraform and the console make after a create', async () => {
    const created = await fn('reads', HELLO, { Tags: { team: 'a' } })
    const read = (route: any, path: string) => send(route.GET, 'GET', path)
    const versions = await read(require('@/app/api/lambda/2015-03-31/functions/[name]/versions/route'), '/2015-03-31/functions/reads/versions')
    expect(versions.body.Versions.map((v: any) => v.Version)).toEqual(['$LATEST'])
    expect((await read(require('@/app/api/lambda/2020-06-30/functions/[name]/code-signing-config/route'), '/2020-06-30/functions/reads/code-signing-config')).body).toEqual({ FunctionName: 'reads' })
    expect((await read(require('@/app/api/lambda/2024-08-31/functions/[name]/recursion-config/route'), '/2024-08-31/functions/reads/recursion-config')).body).toEqual({ RecursiveLoop: 'Terminate' })
    expect((await read(require('@/app/api/lambda/2019-09-30/functions/[name]/concurrency/route'), '/2019-09-30/functions/reads/concurrency')).body).toEqual({})
    const tags = await read(require('@/app/api/lambda/2017-03-31/tags/[arn]/route'), `/2017-03-31/tags/${encodeURIComponent(created.body.FunctionArn)}`)
    expect(tags.body).toEqual({ Tags: { team: 'a' } })
    expect(errorOf(await read(require('@/app/api/lambda/2015-03-31/functions/[name]/versions/route'), '/2015-03-31/functions/nothing/versions')).type).toBe('ResourceNotFoundException')
    await remove('reads')
  })

  it('refuses a function name that exists', async () => {
    await fn('twice', HELLO)
    const again = await fn('twice', HELLO)
    expect(again.status).toBe(409)
    expect(errorOf(again)).toEqual({ type: 'ResourceConflictException', message: 'Function already exist: twice' })
    await remove('twice')
  })

  it('refuses a function in another Region and a version that does not exist', async () => {
    await fn('versions', HELLO)
    const other = await send(functionRoute.GET, 'GET', `/2015-03-31/functions/${encodeURIComponent('arn:aws:lambda:us-east-1:111111111111:function:versions')}`)
    expect(errorOf(other)).toEqual({ type: 'InvalidParameterValueException', message: expect.stringContaining("not reachable in this region ('eu-west-1')") })
    expect(errorOf(await send(functionRoute.GET, 'GET', '/2015-03-31/functions/versions?Qualifier=3')).type).toBe('ResourceNotFoundException')
    expect((await send(functionRoute.GET, 'GET', '/2015-03-31/functions/versions:$LATEST')).status).toBe(200)
    await remove('versions')
  })
})

describe('functions in a VPC', () => {
  const group = () => Object.values<any>(ec2().securityGroups).find(g => g.GroupName === 'default' && g.VpcId === defaultSubnet().VpcId)

  it('shares one interface per subnet and security group combination, and removes it with the last function', async () => {
    const subnet = defaultSubnet()
    const free = () => availableAddressCount(ec2(), subnet)
    const all = free()
    const vpcConfig = { SubnetIds: [subnet.SubnetId] }

    const first = await fn('shared-1', HELLO, { VpcConfig: vpcConfig })
    expect(first.status).toBe(201)
    // no security group given: the default group of the VPC
    expect(first.body.VpcConfig).toEqual({ SubnetIds: [subnet.SubnetId], SecurityGroupIds: [group().GroupId], VpcId: subnet.VpcId, Ipv6AllowedForDualStack: false })
    expect(lambdaInterfaces()).toHaveLength(1)
    const eni = lambdaInterfaces()[0]
    expect(eni).toMatchObject({ SubnetId: subnet.SubnetId, RequesterManaged: true, InterfaceType: 'lambda', Status: 'in-use' })
    expect(eni.Description).toMatch(/^AWS Lambda VPC ENI-shared-1-/)
    expect(eni.Groups.map((g: any) => g.GroupId)).toEqual([group().GroupId])

    // the same combination: the same interface, the same single address
    await fn('shared-2', HELLO, { VpcConfig: { SubnetIds: [subnet.SubnetId], SecurityGroupIds: [group().GroupId] } })
    expect(lambdaInterfaces().map(e => e.NetworkInterfaceId)).toEqual([eni.NetworkInterfaceId])
    // one address for both functions, not one each
    expect(free()).toBe(all - 1)

    // another set of security groups: another interface
    const other = addSecurityGroup(ec2(), scope, { vpcId: subnet.VpcId, name: 'other', description: 'other', tags: [] })
    const state = ec2()
    state.securityGroups[other.GroupId] = other
    saveState(scope, state)
    await fn('other-group', HELLO, { VpcConfig: { SubnetIds: [subnet.SubnetId], SecurityGroupIds: [other.GroupId] } })
    expect(lambdaInterfaces()).toHaveLength(2)

    await remove('shared-1')
    expect(lambdaInterfaces()).toHaveLength(2)
    await remove('shared-2')
    expect(lambdaInterfaces()).toHaveLength(1)
    await remove('other-group')
    expect(lambdaInterfaces()).toHaveLength(0)
    expect(free()).toBe(all)
  })

  it('refuses a subnet or security group that does not exist, or that are in different VPCs', async () => {
    const subnet = defaultSubnet()
    expect(errorOf(await fn('v-1', HELLO, { VpcConfig: { SubnetIds: ['subnet-0000'] } })).message).toMatch(/InvalidSubnetID.NotFound.*'subnet-0000' does not exist/)
    expect(errorOf(await fn('v-2', HELLO, { VpcConfig: { SubnetIds: [subnet.SubnetId], SecurityGroupIds: ['sg-0000'] } })).message).toMatch(/InvalidGroup.NotFound/)
    const state = ec2()
    const vpc = createVpc(state, scope, { cidr: '10.9.0.0/16', tags: [] })
    const foreign = addSecurityGroup(state, scope, { vpcId: vpc.VpcId, name: 'foreign', description: 'foreign', tags: [] })
    state.securityGroups[foreign.GroupId] = foreign
    saveState(scope, state)
    expect(errorOf(await fn('v-3', HELLO, { VpcConfig: { SubnetIds: [subnet.SubnetId], SecurityGroupIds: [foreign.GroupId] } })).message).toMatch(/belong to different networks/)
    expect(lambdaInterfaces()).toHaveLength(0)
  })

  it('creates the function in the Failed state when the interface cannot be created, and refuses to invoke it', async () => {
    const subnet = defaultSubnet()
    setQuota(scope, QUOTAS.networkInterfacesPerRegion, Object.keys(ec2().networkInterfaces).length)
    const created = await fn('failed', HELLO, { VpcConfig: { SubnetIds: [subnet.SubnetId] } })

    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ State: 'Failed', StateReasonCode: 'EniLimitExceeded', LastUpdateStatus: 'Failed' })
    expect(created.body.StateReason).toMatch(/Error occurred while creating ENI\(s\) for function: You have reached the limit/)
    expect(lambdaInterfaces()).toHaveLength(0)
    expect(errorOf(await invoke('failed'))).toEqual({ type: 'ResourceConflictException', message: expect.stringContaining('Failed (EniLimitExceeded)') })
    setQuota(scope, QUOTAS.networkInterfacesPerRegion, 5000)
    await remove('failed')
  })
})

describe('Invoke', () => {
  it('runs the handler and returns its result with the log tail', async () => {
    await fn('hello', HELLO, { MemorySize: 256 })
    const answer = await invoke('hello', { a: 1 }, { 'X-Amz-Log-Type': 'Tail' })

    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ echo: { a: 1 }, memory: '256' })
    expect(answer.headers.get('x-amz-executed-version')).toBe('$LATEST')
    expect(answer.headers.get('x-amz-function-error')).toBeNull()
    const log = Buffer.from(answer.headers.get('x-amz-log-result')!, 'base64').toString()
    expect(log).toMatch(/^START RequestId: [0-9a-f-]{36} Version: \$LATEST\nhello from hello\nEND RequestId: [0-9a-f-]{36}\nREPORT RequestId: [0-9a-f-]{36}\tDuration: [\d.]+ ms\tBilled Duration: \d+ ms\tMemory Size: 256 MB/)
    await remove('hello')
  })

  it('gives the function its environment', async () => {
    await fn('env', source('def handler(event, context):\n    keys = ["AWS_LAMBDA_FUNCTION_NAME", "AWS_LAMBDA_FUNCTION_VERSION", "AWS_LAMBDA_FUNCTION_MEMORY_SIZE", "AWS_LAMBDA_LOG_GROUP_NAME", "AWS_EXECUTION_ENV", "AWS_REGION", "_HANDLER", "STAGE", "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "AWS_ENDPOINT_URL"]\n    return {k: os.environ.get(k) for k in keys} | {"arn": context.invoked_function_arn, "root": os.path.basename(os.environ["LAMBDA_TASK_ROOT"]), "left": context.get_remaining_time_in_millis()}'),
      { Environment: { Variables: { STAGE: 'test' } }, Timeout: 10 })
    const { body } = await invoke('env')

    expect(body).toMatchObject({
      AWS_LAMBDA_FUNCTION_NAME: 'env', AWS_LAMBDA_FUNCTION_VERSION: '$LATEST', AWS_LAMBDA_FUNCTION_MEMORY_SIZE: '128',
      AWS_LAMBDA_LOG_GROUP_NAME: '/aws/lambda/env', AWS_EXECUTION_ENV: 'AWS_Lambda_python3.12', AWS_REGION: region, _HANDLER: 'index.handler',
      STAGE: 'test', AWS_ACCESS_KEY_ID: 'ASIATESTKEY', AWS_SESSION_TOKEN: 'test-token', AWS_ENDPOINT_URL: null,
      arn: `arn:aws:lambda:${region}:${account}:function:env`, root: 'task',
    })
    expect(body.left).toBeGreaterThan(9000)
    expect(body.left).toBeLessThanOrEqual(10000)
    await remove('env')
  })

  it('reports an exception as an unhandled function error, with the status 200 of the invocation', async () => {
    await fn('boom', source('def handler(event, context):\n    raise ValueError("boom")'))
    const answer = await invoke('boom')

    expect(answer.status).toBe(200)
    expect(answer.headers.get('x-amz-function-error')).toBe('Unhandled')
    expect(answer.body).toMatchObject({ errorMessage: 'boom', errorType: 'ValueError' })
    expect(answer.body.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(answer.body.stackTrace.join('')).toContain('raise ValueError("boom")')
    await remove('boom')
  })

  it('reports a handler that cannot be found or imported', async () => {
    await fn('missing-handler', source('def other(event, context):\n    return 1'))
    expect((await invoke('missing-handler')).body).toEqual({ errorMessage: "Handler 'handler' missing on module 'index'", errorType: 'Runtime.HandlerNotFound' })
    await fn('missing-module', HELLO, { Handler: 'nothing.handler' })
    expect((await invoke('missing-module')).body).toMatchObject({ errorType: 'Runtime.ImportModuleError', errorMessage: expect.stringContaining("Unable to import module 'nothing'") })
    await fn('unserializable', source('def handler(event, context):\n    return {1, 2}'))
    expect((await invoke('unserializable')).body).toMatchObject({ errorType: 'Runtime.MarshalError' })
    for (const name of ['missing-handler', 'missing-module', 'unserializable']) {
      await remove(name)
    }
  })

  it('stops the function at its timeout, counting virtual time, and says so', async () => {
    await fn('slow', source('def handler(event, context):\n    print("start")\n    time.sleep(10)\n    print("never")\n    return "late"'), { Timeout: 3 })
    const started = Date.now()
    const answer = await invoke('slow', {}, { 'X-Amz-Log-Type': 'Tail' })

    expect(Date.now() - started).toBeLessThan(8000)
    expect(answer.status).toBe(200)
    expect(answer.headers.get('x-amz-function-error')).toBe('Unhandled')
    expect(answer.body.errorMessage).toMatch(/^\d{4}-.*Z [0-9a-f-]{36} Task timed out after 3\.00 seconds$/)
    const log = Buffer.from(answer.headers.get('x-amz-log-result')!, 'base64').toString()
    expect(log).toContain('start')
    expect(log).toContain('Task timed out after 3.00 seconds')
    expect(log).not.toContain('never')
    expect(log).toMatch(/Duration: 3000\.00 ms/)
    await remove('slow')
  })

  it('answers DryRun and Event invocations without waiting, and refuses a payload that is not JSON', async () => {
    await fn('modes', HELLO)
    const dry = await invoke('modes', {}, { 'X-Amz-Invocation-Type': 'DryRun' })
    expect(dry.status).toBe(204)
    const event = await invoke('modes', {}, { 'X-Amz-Invocation-Type': 'Event' })
    expect(event.status).toBe(202)
    expect(event.text).toBe('')

    const bad = await invoke('modes', '{not json')
    expect(bad.status).toBe(400)
    expect(errorOf(bad)).toEqual({ type: 'InvalidRequestContentException', message: expect.stringContaining('Could not parse request body into json') })
    expect(errorOf(await invoke('modes', {}, { 'X-Amz-Invocation-Type': 'Nope' })).type).toBe('ValidationException')
    expect(errorOf(await invoke('nothing-here')).type).toBe('ResourceNotFoundException')

    // the asynchronous invocation is recorded when it is done
    await new Promise(resolve => setTimeout(resolve, 2500))
    const inspect = await send(inspectRoute.GET, 'GET', `/api/lambda/inspect?account=${account}&region=${region}&function=modes`)
    expect(inspect.body.invocations[0]).toMatchObject({ InvocationType: 'Event', StatusCode: 200 })
    await remove('modes')
  })

  describe('and the network', () => {
    const CALL = source(`def handler(event, context):
    import urllib.request
    try:
        return urllib.request.urlopen("https://${STS}/", timeout=2).read().decode()
    except Exception as e:
        return "FAILED " + type(e).__name__ + ": " + str(e)`)

    it('lets a function without a VPC reach public addresses, and not private ones', async () => {
      await fn('no-vpc', CALL, { Timeout: 30 })
      const answer = await invoke('no-vpc')

      expect(answer.body).toBe('the simulator answers')
      expect(received).toHaveLength(1)
      expect(received[0].host).toBe(STS)
      expect(received[0].headers['user-agent']).toMatch(/Python-urllib/)
      const inspect = await send(inspectRoute.GET, 'GET', `/api/lambda/inspect?account=${account}&region=${region}&function=no-vpc`)
      expect(inspect.body.invocations[0].Connections).toEqual([{ host: STS, port: 443, verdict: 'allow', attempts: 1 }])
      expect(inspect.body.invocations[0].Network).toContain('A function without a VPC runs in a network managed by AWS')

      await fn('private', source('def handler(event, context):\n    import urllib.request\n    try:\n        urllib.request.urlopen("http://10.0.1.5/", timeout=2)\n    except Exception as e:\n        return "FAILED " + type(e).__name__'))
      expect((await invoke('private')).body).toBe('FAILED URLError')
      expect((await send(inspectRoute.GET, 'GET', `/api/lambda/inspect?account=${account}&region=${region}&function=private`)).body.invocations[0].Connections[0])
        .toMatchObject({ verdict: 'deny', cause: 'no-route' })
      await remove('no-vpc')
      await remove('private')
    })

    it('puts a function in a public subnet without a public address nowhere: an internet gateway route alone does not work', async () => {
      await fn('public-subnet', CALL, { Timeout: 30, VpcConfig: { SubnetIds: [defaultSubnet().SubnetId] } })
      const answer = await invoke('public-subnet')

      expect(answer.body).toMatch(/^FAILED /)
      expect(received).toHaveLength(0)
      const inspect = await send(inspectRoute.GET, 'GET', `/api/lambda/inspect?account=${account}&region=${region}&function=public-subnet`)
      expect(inspect.body.invocations[0].Connections[0]).toMatchObject({ verdict: 'deny', cause: 'no-public-ip' })
      expect(inspect.body.invocations[0].Network).toContain('give the interface a public IPv4 address')
      await remove('public-subnet')
    })

    it('reaches the internet from a private subnet only through a NAT gateway, and the trace names it', async () => {
      const state = ec2()
      const vpc = createVpc(state, scope, { cidr: '10.5.0.0/16', tags: [] })
      const zone = { name: 'eu-west-1a', id: 'euw1-az1' }
      const publicSubnet = createSubnet(state, scope, { vpcId: vpc.VpcId, cidr: '10.5.1.0/24', zone, tags: [] }).SubnetId
      const privateSubnet = createSubnet(state, scope, { vpcId: vpc.VpcId, cidr: '10.5.2.0/24', zone, tags: [] }).SubnetId
      state.internetGateways['igw-nat'] = { InternetGatewayId: 'igw-nat', Attachments: [{ VpcId: vpc.VpcId, State: 'available' }], Tags: [] }
      const table = (id: string, subnetId: string, route: Record<string, unknown>) => {
        state.routeTables[id] = {
          RouteTableId: id, VpcId: vpc.VpcId, Tags: [], PropagatingVgws: [],
          Associations: [{ RouteTableAssociationId: `rtbassoc-${id}`, RouteTableId: id, SubnetId: subnetId, AssociationState: { State: 'associated' } }],
          Routes: [{ DestinationCidrBlock: '10.5.0.0/16', GatewayId: 'local', State: 'active' }, { DestinationCidrBlock: '0.0.0.0/0', ...route, State: 'active' }],
        }
      }
      table('rtb-nat-public', publicSubnet, { GatewayId: 'igw-nat' })
      state.addresses['eipalloc-nat'] = { AllocationId: 'eipalloc-nat', PublicIp: '203.0.113.77', Tags: [] }
      state.natGateways['nat-fn'] = {
        NatGatewayId: 'nat-fn', VpcId: vpc.VpcId, SubnetId: publicSubnet, State: 'available', ConnectivityType: 'public', Tags: [],
        NatGatewayAddresses: [{ AllocationId: 'eipalloc-nat', PublicIp: '203.0.113.77', PrivateIp: '10.5.1.5' }],
      }
      const sg = addSecurityGroup(state, scope, { vpcId: vpc.VpcId, name: 'fn', description: 'fn', tags: [] })
      state.securityGroups[sg.GroupId] = sg
      const allow = securityGroupRule(scope, sg.GroupId, true, { CidrIpv4: '0.0.0.0/0' })
      state.securityGroupRules[allow.SecurityGroupRuleId] = allow
      saveState(scope, state)

      await fn('nat-fn', CALL, { Timeout: 30, VpcConfig: { SubnetIds: [privateSubnet], SecurityGroupIds: [sg.GroupId] } })
      const inspectOf = async () => (await send(inspectRoute.GET, 'GET', `/api/lambda/inspect?account=${account}&region=${region}&function=nat-fn`)).body.invocations[0]

      // A: the private subnet only has the local route
      expect((await invoke('nat-fn')).body).toMatch(/^FAILED /)
      expect((await inspectOf()).Connections[0]).toMatchObject({ verdict: 'deny', cause: 'no-route', attempts: 1 })

      // B: a route through the NAT gateway
      const after = ec2()
      after.routeTables['rtb-nat-private'] = {
        RouteTableId: 'rtb-nat-private', VpcId: vpc.VpcId, Tags: [], PropagatingVgws: [],
        Associations: [{ RouteTableAssociationId: 'rtbassoc-private', RouteTableId: 'rtb-nat-private', SubnetId: privateSubnet, AssociationState: { State: 'associated' } }],
        Routes: [{ DestinationCidrBlock: '10.5.0.0/16', GatewayId: 'local', State: 'active' }, { DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-fn', State: 'active' }],
      }
      saveState(scope, after)
      expect((await invoke('nat-fn')).body).toBe('the simulator answers')
      const reached = await inspectOf()
      expect(reached.Connections[0]).toMatchObject({ verdict: 'allow' })
      expect(reached.Network).toContain('source 203.0.113.77 via nat-gateway nat-fn')

      // D: the NAT gateway is gone, the route is a blackhole
      const gone = ec2()
      delete gone.natGateways['nat-fn']
      saveState(scope, gone)
      expect((await invoke('nat-fn')).body).toMatch(/^FAILED /)
      expect((await inspectOf()).Connections[0].cause).toBe('blackhole-route')

      // the interface exists while the function does
      expect(lambdaInterfaces().map(e => e.SubnetId)).toEqual([privateSubnet])
      await remove('nat-fn')
      expect(lambdaInterfaces()).toHaveLength(0)
    })

    it('shows a retrying SDK as one record, and takes the function down at its timeout rather than after the retries', async () => {
      const python = (() => { try { execFileSync('python3', ['-c', 'import boto3'], { stdio: 'ignore' }); return true } catch { return false } })()
      if (!python) {
        return
      }
      await fn('sdk', source('def handler(event, context):\n    import boto3\n    return boto3.client("sts").get_caller_identity()["Arn"]'), { Timeout: 20, VpcConfig: { SubnetIds: [defaultSubnet().SubnetId] } })
      const started = Date.now()
      const answer = await invoke('sdk')

      // Without the shim's clock this takes minutes: five attempts of a 60 s connect timeout
      expect(Date.now() - started).toBeLessThan(15000)
      expect(answer.headers.get('x-amz-function-error')).toBe('Unhandled')
      expect(answer.body.errorMessage).toMatch(/Task timed out after 20\.00 seconds/)
      const record = (await send(inspectRoute.GET, 'GET', `/api/lambda/inspect?account=${account}&region=${region}&function=sdk`)).body.invocations[0]
      expect(record.Connections).toEqual([expect.objectContaining({ host: STS, verdict: 'deny', cause: 'no-public-ip' })])
      await remove('sdk')
    })
  })
})
