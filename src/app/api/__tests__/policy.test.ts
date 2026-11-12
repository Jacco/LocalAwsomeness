import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'jpk-policy-'))
process.env.JPK_DB_ROOT = root

/* eslint-disable @typescript-eslint/no-require-imports */
const { evaluateIdentityPolicies, evaluateResourcePolicy, wildcardMatch, PolicyNotModelled } = require('@/app/api/policy/engine')
const { matchPrincipal, namesPrincipal, accountOf } = require('@/app/api/policy/principal')
const { accessDenial } = require('@/app/api/policy/authorizer')
const { subjectOf } = require('@/app/api/policy/identity')
const iam = require('@/app/api/data/iam')
const { sts } = require('@/app/api/sts/service')
const { ec2 } = require('@/app/api/ec2/service')
const { lambda } = require('@/app/api/lambda/service')
const checkRoute = require('@/app/api/policy/check/route')

const account = '111111111111'
const region = 'eu-west-1'
const ROLE = 'reader'
const SESSION = `arn:aws:sts::${account}:assumed-role/${ROLE}/session`

beforeAll(() => {
  mkdirSync(join(root, account), { recursive: true })
  iam.createRole(account, {
    roleName: ROLE,
    assumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
  })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const policy = (...statements: Record<string, unknown>[]) => ({ source: 'test policy', document: { Version: '2012-10-17', Statement: statements } })
const allow = (action: string | string[], resource: string | string[] = '*') => ({ Effect: 'Allow', Action: action, Resource: resource })
const deny = (action: string | string[], resource: string | string[] = '*') => ({ Effect: 'Deny', Action: action, Resource: resource })

describe('policy evaluation', () => {
  it('denies implicitly without a statement, allows with one', () => {
    expect(evaluateIdentityPolicies([], 'ec2:DescribeVpcs', '*').decision).toBe('implicit-deny')
    expect(evaluateIdentityPolicies([policy(allow('ec2:DescribeVpcs'))], 'ec2:DescribeVpcs', '*').decision).toBe('allow')
    expect(evaluateIdentityPolicies([policy(allow('ec2:DescribeVpcs'))], 'ec2:DescribeSubnets', '*').decision).toBe('implicit-deny')
  })

  it('lets an explicit deny win over an allow, wherever it is', () => {
    const result = evaluateIdentityPolicies([policy(allow('ec2:*')), policy(deny('ec2:DeleteVpc'))], 'ec2:DeleteVpc', '*')
    expect(result.decision).toBe('explicit-deny')
    expect(result.decidedBy).toMatchObject({ effect: 'Deny' })
    expect(evaluateIdentityPolicies([policy(allow('ec2:*')), policy(deny('ec2:DeleteVpc'))], 'ec2:DescribeVpcs', '*').decision).toBe('allow')
  })

  it('matches actions case-insensitively with wildcards, and resources with wildcards', () => {
    expect(wildcardMatch('s3:Get*', 'S3:GetObject', true)).toBe(true)
    expect(wildcardMatch('ec2:Describe?pcs', 'ec2:DescribeVpcs', true)).toBe(true)
    expect(wildcardMatch('arn:aws:s3:::logs/*', 'arn:aws:s3:::logs/a/b')).toBe(true)
    expect(wildcardMatch('arn:aws:s3:::logs/*', 'arn:aws:s3:::other/a')).toBe(false)
    expect(wildcardMatch('a.b', 'axb')).toBe(false)
    const logs = [policy(allow('s3:GetObject', 'arn:aws:s3:::logs/*'))]
    expect(evaluateIdentityPolicies(logs, 's3:GetObject', 'arn:aws:s3:::logs/a').decision).toBe('allow')
    expect(evaluateIdentityPolicies(logs, 's3:GetObject', 'arn:aws:s3:::other/a').decision).toBe('implicit-deny')
  })

  it('handles NotAction and NotResource', () => {
    const everythingButIam = [policy({ Effect: 'Allow', NotAction: 'iam:*', Resource: '*' })]
    expect(evaluateIdentityPolicies(everythingButIam, 'ec2:DescribeVpcs', '*').decision).toBe('allow')
    expect(evaluateIdentityPolicies(everythingButIam, 'iam:CreateRole', '*').decision).toBe('implicit-deny')
    const notThere = [policy({ Effect: 'Allow', Action: 's3:*', NotResource: 'arn:aws:s3:::secret/*' })]
    expect(evaluateIdentityPolicies(notThere, 's3:GetObject', 'arn:aws:s3:::open/a').decision).toBe('allow')
    expect(evaluateIdentityPolicies(notThere, 's3:GetObject', 'arn:aws:s3:::secret/a').decision).toBe('implicit-deny')
  })

  it('explains every statement it looked at', () => {
    const result = evaluateIdentityPolicies([policy(allow('s3:GetObject', 'arn:aws:s3:::a/*'), allow('ec2:*'))], 'ec2:DescribeVpcs', '*')
    expect(result.statements.map((s: { applies: boolean }) => s.applies)).toEqual([false, true])
    expect(result.statements[0].why).toBe('Action s3:GetObject does not match ec2:DescribeVpcs')
  })

  it('refuses to guess when a matching statement has a Condition or a policy variable', () => {
    const conditional = [policy({ ...allow('ec2:DescribeVpcs'), Sid: 'OnlyHere', Condition: { IpAddress: { 'aws:SourceIp': '203.0.113.0/24' } } })]
    expect(() => evaluateIdentityPolicies(conditional, 'ec2:DescribeVpcs', '*')).toThrow(PolicyNotModelled)
    expect(() => evaluateIdentityPolicies(conditional, 'ec2:DescribeVpcs', '*')).toThrow(/statement "OnlyHere".*Condition \(IpAddress\)/)
    // a condition on a statement that does not apply to the request does not matter
    expect(evaluateIdentityPolicies(conditional, 's3:GetObject', '*').decision).toBe('implicit-deny')
    expect(() => evaluateIdentityPolicies([policy(allow('s3:*', 'arn:aws:s3:::home/${aws:username}/*'))], 's3:GetObject', 'x')).toThrow(/policy variable/)
  })
})

describe('principals in resource-based policies', () => {
  const other = '222222222222'
  const otherSession = `arn:aws:sts::${other}:assumed-role/${ROLE}/session`

  it('know the account of a principal', () => {
    expect(accountOf(SESSION)).toBe(account)
    expect(accountOf(`arn:aws:iam::${other}:root`)).toBe(other)
    expect(accountOf('lambda.amazonaws.com')).toBeUndefined()
  })

  it('name a session by its ARN or by its role, in the same account only', () => {
    expect(namesPrincipal(SESSION, SESSION)).toBe(true)
    expect(namesPrincipal(`arn:aws:iam::${account}:role/${ROLE}`, SESSION)).toBe(true)
    expect(namesPrincipal(`arn:aws:iam::${account}:role/some/path/${ROLE}`, SESSION)).toBe(true)
    expect(namesPrincipal(`arn:aws:iam::${account}:role/${ROLE}`, otherSession)).toBe(false)
    expect(namesPrincipal(`arn:aws:iam::${account}:role/writer`, SESSION)).toBe(false)
    expect(namesPrincipal(`arn:aws:sts::${account}:assumed-role/${ROLE}/other`, SESSION)).toBe(false)
  })

  it('tell how a Principal element names the principal', () => {
    expect(matchPrincipal('*', SESSION)).toBe('everyone')
    expect(matchPrincipal({ AWS: ['x', '*'] }, SESSION)).toBe('everyone')
    expect(matchPrincipal({ AWS: `arn:aws:iam::${account}:role/${ROLE}` }, SESSION)).toBe('principal')
    expect(matchPrincipal({ AWS: account }, SESSION)).toBe('account')
    expect(matchPrincipal({ AWS: `arn:aws:iam::${account}:root` }, SESSION)).toBe('account')
    expect(matchPrincipal({ AWS: other }, SESSION)).toBeUndefined()
    expect(matchPrincipal({ Service: 'lambda.amazonaws.com' }, SESSION)).toBeUndefined()
    expect(matchPrincipal(undefined, SESSION)).toBeUndefined()
  })
})

describe('resource-based policy evaluation', () => {
  const bucketPolicy = (...statements: Record<string, unknown>[]) => policy(...statements)
  const grant = (principal: unknown, action = 's3:GetObject', extra: Record<string, unknown> = {}) => ({ Effect: 'Allow', Principal: principal, Action: action, Resource: 'arn:aws:s3:::b/*', ...extra })

  it('needs a statement that names the principal, the action and the resource', () => {
    expect(evaluateResourcePolicy(bucketPolicy(grant({ AWS: account })), SESSION, 's3:GetObject', 'arn:aws:s3:::b/k').decision).toBe('allow')
    expect(evaluateResourcePolicy(bucketPolicy(grant({ AWS: '222222222222' })), SESSION, 's3:GetObject', 'arn:aws:s3:::b/k').decision).toBe('implicit-deny')
    expect(evaluateResourcePolicy(bucketPolicy(grant('*')), SESSION, 's3:PutObject', 'arn:aws:s3:::b/k').decision).toBe('implicit-deny')
    expect(evaluateResourcePolicy(bucketPolicy(grant('*')), SESSION, 's3:GetObject', 'arn:aws:s3:::c/k').decision).toBe('implicit-deny')
    const result = evaluateResourcePolicy(bucketPolicy(grant({ AWS: '222222222222' })), SESSION, 's3:GetObject', 'arn:aws:s3:::b/k')
    expect(result.statements[0].why).toBe(`Principal {"AWS":"222222222222"} does not name ${SESSION}`)
  })

  it('lets a deny win and prefers an allow that names the principal over one that names its account', () => {
    const both = bucketPolicy(grant({ AWS: account }), grant({ AWS: `arn:aws:iam::${account}:role/${ROLE}` }))
    expect(evaluateResourcePolicy(both, SESSION, 's3:GetObject', 'arn:aws:s3:::b/k').decidedBy.principal).toBe('principal')
    const denied = bucketPolicy(grant('*'), { ...grant({ AWS: account }), Effect: 'Deny' })
    expect(evaluateResourcePolicy(denied, SESSION, 's3:GetObject', 'arn:aws:s3:::b/k').decision).toBe('explicit-deny')
  })

  it('refuses to guess about a Condition or NotPrincipal', () => {
    expect(() => evaluateResourcePolicy(bucketPolicy(grant('*', 's3:GetObject', { Condition: { Bool: { 'aws:SecureTransport': 'true' } } })), SESSION, 's3:GetObject', 'arn:aws:s3:::b/k')).toThrow(PolicyNotModelled)
    expect(() => evaluateResourcePolicy(bucketPolicy({ Effect: 'Deny', NotPrincipal: { AWS: account }, Action: '*', Resource: '*' }), SESSION, 's3:GetObject', 'x')).toThrow(/NotPrincipal/)
    // a condition on a statement for someone else does not matter
    expect(evaluateResourcePolicy(bucketPolicy(grant({ AWS: '222222222222' }, 's3:GetObject', { Condition: {} })), SESSION, 's3:GetObject', 'arn:aws:s3:::b/k').decision).toBe('implicit-deny')
  })
})

describe('identity-based and resource-based policies together', () => {
  const OTHER = '222222222222'
  const resource = 'arn:aws:s3:::b/k'
  const owned = (acct: string, ...statements: Record<string, unknown>[]) =>
    ({ account: acct, source: 'bucket policy of b', document: statements.length ? { Version: '2012-10-17', Statement: statements } : undefined })
  const grant = (principal: unknown) => ({ Effect: 'Allow', Principal: principal, Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' })
  const decision = (principal: string, resourcePolicy?: unknown) => {
    const denied = accessDenial(principal, 's3:GetObject', resource, resourcePolicy)
    return denied ? `${denied.type}: ${denied.message.replace(/^.* on resource: \S+ /, '')}` : 'allowed'
  }
  // SESSION has no identity-based policy; an unknown session is not restricted by identity-based policies
  const FREE = `arn:aws:sts::${account}:assumed-role/admin/session`

  it('in the owning account, need an allow in either, where naming only the account delegates to identity policies', () => {
    expect(decision(SESSION, owned(account))).toBe('AccessDenied: because no identity-based policy allows the s3:GetObject action')
    expect(decision(SESSION, owned(account, grant({ AWS: `arn:aws:iam::${account}:role/${ROLE}` })))).toBe('allowed')
    expect(decision(SESSION, owned(account, grant('*')))).toBe('allowed')
    expect(decision(SESSION, owned(account, grant({ AWS: account })))).toBe('AccessDenied: because no identity-based policy allows the s3:GetObject action')
    expect(decision(FREE, owned(account))).toBe('allowed')
  })

  it('from another account, need an allow in both', () => {
    expect(decision(FREE, owned(OTHER))).toBe('AccessDenied: because no resource-based policy allows the s3:GetObject action')
    expect(decision(FREE, owned(OTHER, grant({ AWS: account })))).toBe('allowed')
    expect(decision(SESSION, owned(OTHER, grant({ AWS: account })))).toBe('AccessDenied: because no identity-based policy allows the s3:GetObject action')
    expect(decision(SESSION, owned(OTHER, grant('*')))).toBe('AccessDenied: because no identity-based policy allows the s3:GetObject action')
  })

  it('let an explicit deny in the resource-based policy win, also for an identity that is not restricted', () => {
    expect(decision(FREE, owned(account, { ...grant('*'), Effect: 'Deny' }))).toBe('AccessDenied: with an explicit deny in a resource-based policy')
  })

  it('leave requests without a resource-based policy to the identity-based policies, as before', () => {
    expect(decision(FREE)).toBe('allowed')
    expect(decision(SESSION)).toBe('AccessDenied: because no identity-based policy allows the s3:GetObject action')
  })
})

describe('the permissions of a role', () => {
  it('are the inline and the attached managed policies of the role, and only a role in IAM state is restricted', () => {
    expect(subjectOf(SESSION)).toMatchObject({ restricted: true, policies: [] })
    expect(subjectOf(`arn:aws:iam::${account}:role/${ROLE}`)).toMatchObject({ restricted: true })
    expect(subjectOf(`arn:aws:sts::${account}:assumed-role/unknown/session`)).toMatchObject({ restricted: false })
    expect(subjectOf(`arn:aws:iam::${account}:root`)).toMatchObject({ restricted: false })
    expect(subjectOf(`arn:aws:iam::${account}:role/admin`)).toMatchObject({ restricted: false })
  })
})

describe('permissions on service calls', () => {
  const headers = (principal: string, service: string) => ({
    'x-aws-principal': principal,
    'x-aws-userid': 'AROAEXAMPLE',
    authorization: `AWS4-HMAC-SHA256 Credential=KEY/20250101/${region}/${service}/aws4_request, SignedHeaders=host, Signature=abc`,
  })
  const query = async (service: any, name: string, action: string, principal = SESSION) => {
    const response: Response = await service.post(new Request(`http://localhost/api/${name}`, {
      method: 'POST', body: new URLSearchParams({ Action: action, Version: name === 'sts' ? '2011-06-15' : '2016-11-15' }).toString(), headers: headers(principal, name),
    }))
    return { status: response.status, text: await response.text() }
  }
  const listFunctions = async (principal = SESSION) => {
    const response: Response = await lambda.postAction('ListFunctions')(new Request('http://localhost/2015-03-31/functions/', { method: 'GET', headers: headers(principal, 'lambda') }))
    return { status: response.status, errorType: response.headers.get('x-amzn-errortype'), body: await response.json() }
  }

  it('deny a role without a policy, in the form each service uses', async () => {
    const lambdaDenied = await listFunctions()
    expect(lambdaDenied.status).toBe(403)
    expect(lambdaDenied.errorType).toBe('AccessDeniedException')
    expect(lambdaDenied.body.Message).toBe(`User: ${SESSION} is not authorized to perform: lambda:ListFunctions on resource: * because no identity-based policy allows the lambda:ListFunctions action`)

    const ec2Denied = await query(ec2, 'ec2', 'DescribeVpcs')
    expect(ec2Denied.status).toBe(403)
    expect(ec2Denied.text).toContain('<Code>UnauthorizedOperation</Code>')
    expect(ec2Denied.text).toContain(`You are not authorized to perform this operation. User: ${SESSION} is not authorized to perform: ec2:DescribeVpcs`)

    const stsDenied = await query(sts, 'sts', 'AssumeRole')
    expect(stsDenied.status).toBe(403)
    expect(stsDenied.text).toContain('AccessDenied')
  })

  it('never deny sts:GetCallerIdentity, as in AWS: it needs no permission, not even against an explicit deny', async () => {
    expect((await query(sts, 'sts', 'GetCallerIdentity')).status).toBe(200)
    iam.putRolePolicy(account, ROLE, 'deny-everything', { Version: '2012-10-17', Statement: [deny('*')] })
    const answer = await query(sts, 'sts', 'GetCallerIdentity')
    expect(answer.status).toBe(200)
    expect(answer.text).toContain(SESSION)
    iam.deleteRolePolicy(account, ROLE, 'deny-everything')
  })

  it('allow what an inline policy allows, and say when an explicit deny is the reason', async () => {
    iam.putRolePolicy(account, ROLE, 'read', { Version: '2012-10-17', Statement: [allow(['lambda:ListFunctions', 'ec2:Describe*'])] })
    expect((await listFunctions()).status).toBe(200)
    expect((await query(ec2, 'ec2', 'DescribeVpcs')).status).toBe(200)
    // still not allowed: another action
    expect((await query(ec2, 'ec2', 'CreateVpc')).status).toBe(403)

    iam.putRolePolicy(account, ROLE, 'no-lambda', { Version: '2012-10-17', Statement: [deny('lambda:*')] })
    const denied = await listFunctions()
    expect(denied.status).toBe(403)
    expect(denied.body.Message).toMatch(/with an explicit deny in an identity-based policy$/)
    iam.deleteRolePolicy(account, ROLE, 'no-lambda')
    iam.deleteRolePolicy(account, ROLE, 'read')
    expect((await listFunctions()).status).toBe(403)
  })

  it('apply to the resources an operation names', async () => {
    iam.putRolePolicy(account, ROLE, 'one-function', { Version: '2012-10-17', Statement: [allow('lambda:GetFunction', `arn:aws:lambda:${region}:${account}:function:allowed`)] })
    const get = async (name: string) => {
      const response: Response = await lambda.postAction('GetFunction')(new Request(`http://localhost/2015-03-31/functions/${name}`, { method: 'GET', headers: headers(SESSION, 'lambda') }))
      return { status: response.status, type: response.headers.get('x-amzn-errortype') }
    }
    // allowed by the policy, so the answer is the function's: it does not exist
    expect(await get('allowed')).toEqual({ status: 404, type: 'ResourceNotFoundException' })
    expect(await get('other')).toEqual({ status: 403, type: 'AccessDeniedException' })
    iam.deleteRolePolicy(account, ROLE, 'one-function')
  })

  it('leave unknown identities alone, such as the bootstrap and test identities', async () => {
    expect((await listFunctions(`arn:aws:sts::${account}:assumed-role/admin/session`)).status).toBe(200)
    expect((await listFunctions(`arn:aws:iam::${account}:root`)).status).toBe(200)
  })

  it('answer with a clear error when a policy needs something the simulator cannot evaluate', async () => {
    iam.putRolePolicy(account, ROLE, 'conditional', {
      Version: '2012-10-17',
      Statement: [{ ...allow('lambda:ListFunctions'), Sid: 'OnlyFromHere', Condition: { IpAddress: { 'aws:SourceIp': '203.0.113.0/24' } } }],
    })
    const answer = await listFunctions()
    expect(answer.status).toBe(501)
    expect(answer.errorType).toBe('PolicyNotModelled')
    expect(answer.body.Message).toMatch(/cannot decide whether .* may perform lambda:ListFunctions.*statement "OnlyFromHere".*Condition \(IpAddress\)/)
    iam.deleteRolePolicy(account, ROLE, 'conditional')
  })
})

describe('the can-X-perform-Y query', () => {
  const check = async (params: Record<string, string>) => {
    const response: Response = await checkRoute.GET(new Request(`http://localhost/api/policy/check?${new URLSearchParams(params)}`))
    return { status: response.status, body: await response.json() }
  }

  it('answers with the statements it looked at', async () => {
    iam.putRolePolicy(account, ROLE, 'ec2-read', { Version: '2012-10-17', Statement: [{ Sid: 'Read', ...allow('ec2:Describe*') }, { Sid: 'Writes', ...deny('ec2:Delete*') }] })

    const allowed = await check({ principal: SESSION, action: 'ec2:DescribeVpcs' })
    expect(allowed.body).toMatchObject({ restricted: true, decision: 'allow', decidedBy: { sid: 'Read', effect: 'Allow' } })
    const denied = await check({ principal: SESSION, action: 'ec2:DeleteVpc' })
    expect(denied.body).toMatchObject({ decision: 'explicit-deny', decidedBy: { sid: 'Writes' } })
    expect(denied.body.statements).toHaveLength(2)
    expect((await check({ principal: SESSION, action: 'lambda:ListFunctions' })).body.decision).toBe('implicit-deny')
    expect((await check({ principal: `arn:aws:iam::${account}:root`, action: 'anything:Do' })).body).toMatchObject({ restricted: false, decision: 'allow' })
    expect((await check({ principal: SESSION })).status).toBe(400)
    iam.deleteRolePolicy(account, ROLE, 'ec2-read')
  })
})
