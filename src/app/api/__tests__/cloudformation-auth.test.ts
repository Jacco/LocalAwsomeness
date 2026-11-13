import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'jpk-cfn-auth-'))
process.env.JPK_DB_ROOT = root

// CreateStack starts the deployment engine: use the fake one, which calls no API.
process.env.JPK_PYTHON = process.execPath
process.env.JPK_CF_ENGINE = join(__dirname, 'fixtures', 'fake-cf-engine.js')

// Sessions are issued into the shared credentials store, which does not follow JPK_DB_ROOT: keep the tests out of db/.
jest.mock('@/app/api/data/credentials', () => ({
  issueSession: jest.fn((_account: string, principal: string, userId: string) =>
    ({ keyId: 'ASIATESTKEY', secret: 'test-secret', sessionToken: 'test-token', expiration: Date.now() + 3600_000, userId, principal })),
}))

/* eslint-disable @typescript-eslint/no-require-imports */
const iam = require('@/app/api/data/iam')
const { cloudFormation } = require('@/app/api/cloudformation/service')
const { deploymentSession } = require('@/app/api/cloudformation/role')
const { issueSession } = require('@/app/api/data/credentials')
const { readCloudTrailEvents, clearCloudTrailEvents } = require('@/app/api/cloudtrail/cloudtrail')

const account = '111111111111'
const region = 'eu-west-1'
const DEPLOYER = `arn:aws:sts::${account}:assumed-role/deployer/alice`
// No role "admin" exists, so its identity is not restricted by identity-based policies.
const ADMIN = `arn:aws:sts::${account}:assumed-role/admin/bob`
const SERVICE_ROLE = `arn:aws:iam::${account}:role/cfn-service`
const LAMBDA_ROLE = `arn:aws:iam::${account}:role/lambda-only`
const TEMPLATE = JSON.stringify({ Resources: { P: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/p', Type: 'String', Value: 'v' } } } })

const trust = (service: string) => ({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole' }] })

beforeAll(() => {
  mkdirSync(join(root, account), { recursive: true })
  iam.createRole(account, { roleName: 'cfn-service', assumeRolePolicyDocument: trust('cloudformation.amazonaws.com') })
  iam.createRole(account, { roleName: 'lambda-only', assumeRolePolicyDocument: trust('lambda.amazonaws.com') })
  iam.createRole(account, { roleName: 'deployer', assumeRolePolicyDocument: trust('ec2.amazonaws.com') })
  iam.putRolePolicy(account, 'deployer', 'deploy', {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: 'cloudformation:*', Resource: `arn:aws:cloudformation:${region}:${account}:stack/allowed-*` },
      { Effect: 'Allow', Action: 'iam:PassRole', Resource: '*', Condition: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } } },
      { Effect: 'Deny', Action: 'iam:PassRole', Resource: LAMBDA_ROLE },
    ],
  })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function call(principal: string, params: Record<string, string>) {
  const response: Response = await cloudFormation.post(new Request('http://localhost/api/cloudformation/', {
    method: 'POST',
    body: new URLSearchParams({ Version: '2010-05-15', ...params }).toString(),
    headers: {
      'x-aws-principal': principal,
      'x-aws-userid': 'AROAEXAMPLE:session',
      authorization: `AWS4-HMAC-SHA256 Credential=KEY/20250101/${region}/cloudformation/aws4_request, SignedHeaders=host, Signature=abc`,
    },
  }))
  return { status: response.status, text: await response.text() }
}

const createStack = (principal: string, name: string, extra: Record<string, string> = {}) =>
  call(principal, { Action: 'CreateStack', StackName: name, TemplateBody: TEMPLATE, ...extra })

describe('CloudFormation authorization', () => {
  it('checks the stack operation against the stack ARN', async () => {
    const created = await createStack(DEPLOYER, 'allowed-plain')
    expect(created.status).toBe(200)
    expect(created.text).toContain(`<StackId>arn:aws:cloudformation:${region}:${account}:stack/allowed-plain/`)

    const denied = await createStack(DEPLOYER, 'other')
    expect(denied.status).toBe(403)
    expect(denied.text).toContain('<Code>AccessDenied</Code>')
    expect(denied.text).toContain(`cloudformation:CreateStack on resource: arn:aws:cloudformation:${region}:${account}:stack/other/*`)

    expect((await call(DEPLOYER, { Action: 'DescribeStacks', StackName: 'allowed-plain' })).status).toBe(200)
    expect((await call(DEPLOYER, { Action: 'DescribeStacks', StackName: 'other' })).status).toBe(403)
    expect((await call(DEPLOYER, { Action: 'ListStacks' })).status).toBe(403)
  })

  it('requires iam:PassRole, with iam:PassedToService cloudformation.amazonaws.com, for a service role', async () => {
    expect((await createStack(DEPLOYER, 'allowed-role', { RoleARN: SERVICE_ROLE })).status).toBe(200)

    const denied = await createStack(DEPLOYER, 'allowed-lambda-role', { RoleARN: LAMBDA_ROLE })
    expect(denied.status).toBe(403)
    expect(denied.text).toContain(`iam:PassRole on resource: ${LAMBDA_ROLE} with an explicit deny`)
    expect((await call(DEPLOYER, { Action: 'DescribeStacks', StackName: 'allowed-lambda-role' })).text).toContain('does not exist')

    const onDelete = await call(DEPLOYER, { Action: 'DeleteStack', StackName: 'allowed-plain', RoleARN: LAMBDA_ROLE })
    expect(onDelete.status).toBe(403)
  })

  it('records the PassRole check in CloudTrail as a simulated event, allowed or denied', async () => {
    clearCloudTrailEvents(account)
    await createStack(DEPLOYER, 'allowed-trail-ok', { RoleARN: SERVICE_ROLE })
    await createStack(DEPLOYER, 'allowed-trail-denied', { RoleARN: LAMBDA_ROLE })
    const passRoles = readCloudTrailEvents(account).filter((e: any) => e.action === 'PassRole')
    expect(passRoles).toEqual([
      expect.objectContaining({ principal: DEPLOYER, service: 'iam', resource: SERVICE_ROLE, authorizationDecision: 'allow', simulated: true,
        parameters: expect.objectContaining({ passedToService: 'cloudformation.amazonaws.com' }) }),
      expect.objectContaining({ principal: DEPLOYER, resource: LAMBDA_ROLE, authorizationDecision: 'deny', simulated: true,
        errorCode: 'AccessDenied', authorizationReason: expect.stringContaining('explicit deny') }),
    ])
  })

  it('records a call that was authorized but failed with its error, before the events it caused', async () => {
    clearCloudTrailEvents(account)
    await createStack(DEPLOYER, 'allowed-fails-on-passrole', { RoleARN: LAMBDA_ROLE })
    await createStack(DEPLOYER, 'allowed-ok')
    const events = readCloudTrailEvents(account).map((e: any) => [e.action, e.authorizationDecision, e.errorCode])
    expect(events).toEqual([
      ['CreateStack', 'allow', 'AccessDenied'],
      ['PassRole', 'deny', 'AccessDenied'],
      ['CreateStack', 'allow', undefined],
      ['GenerateDataKey', 'allow', undefined],
      ['Decrypt', 'allow', undefined], // the deployment reading the template
    ])
    const failed = readCloudTrailEvents(account, { action: 'CreateStack' })[0]
    expect(failed.errorMessage).toContain('iam:PassRole')
  })

  it('rejects a role CloudFormation cannot assume, after the PassRole check', async () => {
    for (const roleArn of [LAMBDA_ROLE, `arn:aws:iam::${account}:role/missing`]) {
      const response = await createStack(ADMIN, 'allowed-untrusted', { RoleARN: roleArn })
      expect(response.status).toBe(400)
      expect(response.text).toContain(`Role ${roleArn} is invalid or cannot be assumed`)
    }
    expect((await createStack(ADMIN, 'allowed-bad-arn', { RoleARN: 'not-an-arn' })).text).toContain("at 'roleARN' failed to satisfy constraint")
  })
})

describe('deployment session', () => {
  const caller = { principal: DEPLOYER, userId: 'AROAEXAMPLE:alice', account, region }
  const assumeRoleEvents = () => readCloudTrailEvents(account).filter((e: any) => e.service === 'sts' && e.action === 'AssumeRole')
  beforeEach(() => clearCloudTrailEvents(account))

  it('assumes the service role as CloudFormation', () => {
    const session = deploymentSession(caller, SERVICE_ROLE)
    expect(session.principal).toBe(`arn:aws:sts::${account}:assumed-role/cfn-service/AWSCloudFormation`)
    expect(session.credentials.accessKeyId).toBeTruthy()
    expect(session.credentials.secretAccessKey).toBeTruthy()
    expect(issueSession).toHaveBeenLastCalledWith(account, session.principal, expect.stringMatching(/^AROA.*:AWSCloudFormation$/), 3600)
    expect(() => deploymentSession(caller, LAMBDA_ROLE)).toThrow(/cannot be assumed/)
  })

  it('records the assumption in CloudTrail as an sts:AssumeRole by cloudformation.amazonaws.com', () => {
    deploymentSession(caller, SERVICE_ROLE)
    expect(() => deploymentSession(caller, LAMBDA_ROLE)).toThrow()
    expect(assumeRoleEvents()).toEqual([
      expect.objectContaining({
        principal: 'cloudformation.amazonaws.com', resource: SERVICE_ROLE, authorizationDecision: 'allow', account, region,
        parameters: expect.objectContaining({ roleSessionName: 'AWSCloudFormation', invokedBy: 'cloudformation.amazonaws.com' }),
      }),
      expect.objectContaining({
        principal: 'cloudformation.amazonaws.com', resource: LAMBDA_ROLE, authorizationDecision: 'deny', errorCode: 'AccessDenied',
        authorizationReason: expect.stringContaining('does not allow cloudformation.amazonaws.com'),
      }),
    ])
  })

  it('acts as the caller without a service role', () => {
    const session = deploymentSession(caller)
    expect(session.principal).toBe(DEPLOYER)
    expect(issueSession).toHaveBeenLastCalledWith(account, DEPLOYER, 'AROAEXAMPLE:alice', 3600)
    expect(assumeRoleEvents()).toEqual([])
  })
})
