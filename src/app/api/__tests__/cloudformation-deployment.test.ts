import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'jpk-cfn-deploy-'))
process.env.JPK_DB_ROOT = root
process.env.JPK_PYTHON = process.execPath
process.env.JPK_CF_ENGINE = join(__dirname, 'fixtures', 'fake-cf-engine.js')
const configOut = join(root, 'engine-config.json')
process.env.FAKE_ENGINE_CONFIG_OUT = configOut

jest.mock('@/app/api/data/credentials', () => ({
  issueSession: jest.fn((_account: string, principal: string, userId: string) =>
    ({ keyId: 'ASIATESTKEY', secret: 'test-secret', sessionToken: 'test-token', expiration: Date.now() + 3600_000, userId, principal })),
}))

/* eslint-disable @typescript-eslint/no-require-imports */
const iam = require('@/app/api/data/iam')
const { cloudFormation } = require('@/app/api/cloudformation/service')

const account = '111111111111'
const region = 'eu-west-1'
const CALLER = `arn:aws:sts::${account}:assumed-role/admin/alice`
const SERVICE_ROLE = `arn:aws:iam::${account}:role/cfn-service`
const stackDir = (name: string) => join(root, 'data', 'accounts', account, 'cloudformation', 'stacks', name)

beforeAll(() => {
  mkdirSync(join(root, account), { recursive: true })
  iam.createRole(account, {
    roleName: 'cfn-service',
    assumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'cloudformation.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
  })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function call(params: Record<string, string>) {
  const response: Response = await cloudFormation.post(new Request('http://localhost/api/cloudformation/', {
    method: 'POST',
    body: new URLSearchParams({ Version: '2010-05-15', ...params }).toString(),
    headers: {
      'x-aws-principal': CALLER,
      'x-aws-userid': 'AROAEXAMPLE:alice',
      authorization: `AWS4-HMAC-SHA256 Credential=KEY/20250101/${region}/cloudformation/aws4_request, SignedHeaders=host, Signature=abc`,
    },
  }))
  return { status: response.status, text: await response.text() }
}

const statusOf = async (name: string) => (await call({ Action: 'DescribeStacks', StackName: name })).text.match(/<StackStatus>(\w+)</)?.[1]

async function waitWhileInProgress(name: string): Promise<string | undefined> {
  for (let i = 0; i < 100; i++) {
    const status = await statusOf(name)
    if (!status?.endsWith('_IN_PROGRESS')) return status
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`${name} is still in progress`)
}

const template = (resources: Record<string, unknown>) => JSON.stringify({ Resources: resources })
const PARAM = { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'v' } }

describe('CreateStack deploys through the engine', () => {
  it('returns while CREATE_IN_PROGRESS and ends CREATE_COMPLETE with the resources and events', async () => {
    const created = await call({ Action: 'CreateStack', StackName: 'ok', TemplateBody: template({ A: PARAM, B: PARAM }), RoleARN: SERVICE_ROLE })
    expect(created.status).toBe(200)
    expect(await waitWhileInProgress('ok')).toBe('CREATE_COMPLETE')

    const config = JSON.parse(readFileSync(configOut, 'utf8'))
    expect(config).toMatchObject({ stackName: 'ok', account, region, operation: 'CREATE', roleArn: SERVICE_ROLE, previousResources: {} })
    expect(config.credentials).toMatchObject({ accessKeyId: 'ASIATESTKEY', sessionToken: 'test-token' })
    expect(JSON.parse(config.templateBody).Resources.A.Type).toBe('AWS::SSM::Parameter')

    const resources = (await call({ Action: 'DescribeStackResources', StackName: 'ok' })).text
    expect(resources).toContain('<PhysicalResourceId>phys-A</PhysicalResourceId>')
    expect(resources.match(/<ResourceStatus>CREATE_COMPLETE</g)).toHaveLength(2)

    const events = (await call({ Action: 'DescribeStackEvents', StackName: 'ok' })).text
    const statuses = [...events.matchAll(/<LogicalResourceId>(\w+)<\/LogicalResourceId>[\s\S]*?<ResourceStatus>(\w+)</g)].map(m => `${m[1]}:${m[2]}`)
    expect(statuses).toEqual(['ok:CREATE_COMPLETE', 'B:CREATE_COMPLETE', 'B:CREATE_IN_PROGRESS', 'A:CREATE_COMPLETE', 'A:CREATE_IN_PROGRESS', 'ok:CREATE_IN_PROGRESS'])

    const described = (await call({ Action: 'DescribeStacks', StackName: 'ok' })).text
    expect(described).not.toContain('__deployed')
  })

  it('rolls back a failed resource and reports why', async () => {
    await call({ Action: 'CreateStack', StackName: 'fails', TemplateBody: template({ A: PARAM, B: { ...PARAM, Properties: { ...PARAM.Properties, Fail: true } } }) })
    expect(await waitWhileInProgress('fails')).toBe('ROLLBACK_COMPLETE')
    const described = (await call({ Action: 'DescribeStacks', StackName: 'fails' })).text
    expect(described).toContain('<StackStatusReason>B: boom</StackStatusReason>')
    const resources = (await call({ Action: 'DescribeStackResources', StackName: 'fails' })).text
    expect(resources).toMatch(/<LogicalResourceId>B<\/LogicalResourceId>[\s\S]*?<ResourceStatus>CREATE_FAILED</)
    expect(resources).toMatch(/<LogicalResourceId>A<\/LogicalResourceId>[\s\S]*?<ResourceStatus>DELETE_COMPLETE</)
  })

  it('fails the stack when the engine dies without a result', async () => {
    process.env.JPK_CF_ENGINE = join(__dirname, 'fixtures', 'does-not-exist.js')
    try {
      await call({ Action: 'CreateStack', StackName: 'crash', TemplateBody: template({ A: PARAM }) })
      expect(await waitWhileInProgress('crash')).toBe('CREATE_FAILED')
      expect((await call({ Action: 'DescribeStacks', StackName: 'crash' })).text).toMatch(/exited with code 1 without a result/)
    } finally {
      process.env.JPK_CF_ENGINE = join(__dirname, 'fixtures', 'fake-cf-engine.js')
    }
  })
})

describe('DeleteStack deletes the deployed resources first', () => {
  it('passes the deployed state to the engine and removes the stack when done', async () => {
    await call({ Action: 'CreateStack', StackName: 'gone', TemplateBody: template({ A: PARAM }) })
    expect(await waitWhileInProgress('gone')).toBe('CREATE_COMPLETE')

    expect((await call({ Action: 'DeleteStack', StackName: 'gone' })).status).toBe(200)
    for (let i = 0; i < 100 && existsSync(stackDir('gone')); i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(existsSync(stackDir('gone'))).toBe(false)
    const config = JSON.parse(readFileSync(configOut, 'utf8'))
    expect(config).toMatchObject({ operation: 'DELETE', previousResources: { A: { physicalId: 'phys-A' } } })
    expect(config.templateBody).toBeUndefined()
  })

  it('refuses to delete a stack that is still in progress', async () => {
    await call({ Action: 'CreateStack', StackName: 'busy', TemplateBody: template({ A: PARAM }) })
    const response = await call({ Action: 'DeleteStack', StackName: 'busy' })
    expect(response.status).toBe(400)
    expect(response.text).toContain('is in CREATE_IN_PROGRESS state and can not be deleted now')
    expect(await waitWhileInProgress('busy')).toBe('CREATE_COMPLETE')
  })
})
