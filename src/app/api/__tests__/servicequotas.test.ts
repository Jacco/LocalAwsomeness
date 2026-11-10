import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'jpk-servicequotas-'))
process.env.JPK_DB_ROOT = root

/* eslint-disable @typescript-eslint/no-require-imports */
const { servicequotas } = require('@/app/api/servicequotas/service')
const { ec2 } = require('@/app/api/ec2/service')
const { QUOTAS, quota, setApprovalPolicy, setQuota, decideRequest } = require('@/app/api/quotas')
const { provisionAccount } = require('@/app/api/db/ec2/state')
const { quotaDefinitions } = require('@/app/api/db/reference')

const ACCOUNTS = ['111111111111', '222222222222', '333333333333', '444444444444', '555555555555']

beforeAll(() => ACCOUNTS.forEach(account => mkdirSync(join(root, account), { recursive: true })))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const headers = (account: string, region: string, service: string) => ({
  'x-aws-principal': `arn:aws:sts::${account}:assumed-role/admin/session`,
  'x-aws-userid': 'AROAEXAMPLE',
  authorization: `AWS4-HMAC-SHA256 Credential=KEY/20250101/${region}/${service}/aws4_request, SignedHeaders=host, Signature=abc`,
})

interface Result {
  status: number
  body: any
}

async function call(account: string, action: string, params: Record<string, unknown> = {}, region = 'eu-west-1'): Promise<Result> {
  const response: Response = await servicequotas.postDynamic(
    new Request('http://localhost/api/servicequotas', {
      method: 'POST',
      body: JSON.stringify(params),
      headers: {
        ...headers(account, region, 'servicequotas'),
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `ServiceQuotasV20190624.${action}`,
      },
    }),
    { params: Promise.resolve({ action }) }
  )
  return { status: response.status, body: await response.json() }
}

const VPCS = { ServiceCode: 'vpc', QuotaCode: 'L-F678F1CE' }
const SUBNETS = { ServiceCode: 'vpc', QuotaCode: 'L-407747CB' }
const NACL_RULES = { ServiceCode: 'vpc', QuotaCode: 'L-2AEEBF1A' }
const [A, B, C, D, E] = ACCOUNTS

describe('service quotas: reading quotas', () => {
  it('lists the services and quotas that have a Service Quotas code, with the applied value', async () => {
    const services = (await call(A, 'ListServices')).body
    expect(services.Services).toEqual([
      { ServiceCode: 'ec2', ServiceName: 'Amazon Elastic Compute Cloud (Amazon EC2)' },
      { ServiceCode: 'logs', ServiceName: 'Amazon CloudWatch Logs' },
      { ServiceCode: 'vpc', ServiceName: 'Amazon Virtual Private Cloud (Amazon VPC)' },
    ])

    const { Quotas } = (await call(A, 'ListServiceQuotas', { ServiceCode: 'vpc' })).body
    // hard limits without a quota code are not listed
    expect(Quotas.map((q: any) => q.QuotaCode).sort()).toEqual(
      Object.values(quotaDefinitions() as Record<string, any>).filter(d => d.code && d.service === 'vpc').map(d => d.code).sort())
    expect(Quotas.find((q: any) => q.QuotaCode === 'L-F678F1CE')).toEqual({
      ServiceCode: 'vpc',
      ServiceName: 'Amazon Virtual Private Cloud (Amazon VPC)',
      QuotaArn: `arn:aws:servicequotas:eu-west-1:${A}:vpc/L-F678F1CE`,
      QuotaCode: 'L-F678F1CE',
      QuotaName: 'VPCs per Region',
      Value: 5,
      Unit: 'None',
      Adjustable: true,
      GlobalQuota: false,
      QuotaAppliedAtLevel: 'ACCOUNT',
    })
    const one = (await call(A, 'ListServiceQuotas', { ServiceCode: 'vpc', QuotaCode: 'L-407747CB' })).body.Quotas
    expect(one.map((q: any) => q.QuotaName)).toEqual(['Subnets per VPC'])
  })

  it('reports what the registry enforces: applied values follow the account, defaults do not', async () => {
    setQuota({ account: B, region: 'eu-west-1' }, QUOTAS.vpcsPerRegion, 9)
    expect((await call(B, 'GetServiceQuota', VPCS)).body.Quota.Value).toBe(9)
    expect((await call(B, 'GetServiceQuota', VPCS, 'eu-central-1')).body.Quota.Value).toBe(5)
    expect((await call(A, 'GetServiceQuota', VPCS)).body.Quota.Value).toBe(5)
    const defaults = (await call(B, 'GetAWSDefaultServiceQuota', VPCS)).body.Quota
    expect(defaults.Value).toBe(5)
    expect(defaults.QuotaAppliedAtLevel).toBeUndefined()
    expect((await call(B, 'ListAWSDefaultServiceQuotas', { ServiceCode: 'vpc' })).body.Quotas.every((q: any) => !('QuotaAppliedAtLevel' in q))).toBe(true)

    // every listed quota reports exactly the value the registry would enforce
    for (const [key, def] of Object.entries(quotaDefinitions() as Record<string, any>).filter(([, d]) => d.code)) {
      const reported = (await call(B, 'GetServiceQuota', { ServiceCode: def.service, QuotaCode: def.code })).body.Quota.Value
      expect(reported).toBe(quota({ account: B, region: 'eu-west-1' }, key))
    }
  })

  it('pages results', async () => {
    const first = (await call(A, 'ListServiceQuotas', { ServiceCode: 'vpc', MaxResults: 3 })).body
    expect(first.Quotas).toHaveLength(3)
    expect(first.NextToken).toBeDefined()
    const second = (await call(A, 'ListServiceQuotas', { ServiceCode: 'vpc', MaxResults: 100, NextToken: first.NextToken })).body
    const all = (await call(A, 'ListServiceQuotas', { ServiceCode: 'vpc' })).body.Quotas
    expect([...first.Quotas, ...second.Quotas]).toEqual(all)
    expect(second.NextToken).toBeUndefined()
  })

  it('answers with the API errors for unknown and invalid input', async () => {
    expect((await call(A, 'GetServiceQuota', { ServiceCode: 'nope', QuotaCode: 'L-F678F1CE' })).body.__type).toBe('NoSuchResourceException')
    expect((await call(A, 'GetServiceQuota', { ServiceCode: 'vpc', QuotaCode: 'L-00000000' })).body.__type).toBe('NoSuchResourceException')
    expect((await call(A, 'ListServiceQuotas', { ServiceCode: 'nope' })).body.__type).toBe('NoSuchResourceException')
    expect((await call(A, 'ListServiceQuotas', {})).body.__type).toBe('IllegalArgumentException')
    expect((await call(A, 'ListServices', { MaxResults: 0 })).body.__type).toBe('IllegalArgumentException')
    expect((await call(A, 'ListServices', { NextToken: 'bm9wZQ==' })).body.__type).toBe('InvalidPaginationTokenException')
    const unknown = await call(A, 'DeleteServiceQuota')
    expect(unknown.status).toBe(400)
  })
})

describe('service quotas: requesting increases', () => {
  it('approves a request at once by default and the new value is enforced', async () => {
    const scope = { account: C, region: 'eu-west-1' }
    provisionAccount(C)
    setQuota(scope, QUOTAS.subnetsPerVpc, 2)

    const requested = (await call(C, 'RequestServiceQuotaIncrease', { ...SUBNETS, DesiredValue: 3 })).body.RequestedQuota
    expect(requested).toMatchObject({
      ServiceCode: 'vpc', QuotaCode: 'L-407747CB', QuotaName: 'Subnets per VPC', DesiredValue: 3, Status: 'APPROVED',
      QuotaRequestedAtLevel: 'ACCOUNT', Requester: `arn:aws:sts::${C}:assumed-role/admin/session`,
    })
    expect(requested.Id).toMatch(/^[0-9a-f]{32}$/)
    expect(typeof requested.Created).toBe('number')
    expect((await call(C, 'GetServiceQuota', SUBNETS)).body.Quota.Value).toBe(3)

    // the registry, and with it EC2, uses the raised quota right away
    const ec2Call = async (action: string, params: Record<string, string>) => {
      const body = new URLSearchParams({ Action: action, Version: '2016-11-15', ...params }).toString()
      const response: Response = await ec2.post(new Request('http://localhost/api/ec2', {
        method: 'POST', body, headers: { ...headers(C, 'eu-west-1', 'ec2'), 'content-type': 'application/x-www-form-urlencoded' },
      }))
      return { status: response.status, raw: await response.text() }
    }
    const vpc = /<vpcId>(vpc-[0-9a-f]+)<\/vpcId>/.exec((await ec2Call('CreateVpc', { CidrBlock: '10.0.0.0/16' })).raw)![1]
    for (const third of [1, 2, 3]) {
      expect((await ec2Call('CreateSubnet', { VpcId: vpc, CidrBlock: `10.0.${third}.0/24` })).status).toBe(200)
    }
    const fourth = await ec2Call('CreateSubnet', { VpcId: vpc, CidrBlock: '10.0.4.0/24' })
    expect(fourth.status).toBe(400)
    expect(fourth.raw).toContain('SubnetLimitExceeded')
  })

  it('rejects requests that are not an increase, and unknown quotas', async () => {
    expect((await call(D, 'RequestServiceQuotaIncrease', { ...VPCS, DesiredValue: 5 })).body.__type).toBe('IllegalArgumentException')
    expect((await call(D, 'RequestServiceQuotaIncrease', { ...VPCS, DesiredValue: 2 })).body.__type).toBe('IllegalArgumentException')
    expect((await call(D, 'RequestServiceQuotaIncrease', { ...VPCS })).body.__type).toBe('IllegalArgumentException')
    expect((await call(D, 'RequestServiceQuotaIncrease', { ServiceCode: 'vpc', QuotaCode: 'L-00000000', DesiredValue: 9 })).body.__type).toBe('NoSuchResourceException')
    expect((await call(D, 'GetServiceQuota', VPCS)).body.Quota.Value).toBe(5)
  })

  it('does not raise a quota above its documented maximum', async () => {
    const denied = (await call(D, 'RequestServiceQuotaIncrease', { ...NACL_RULES, DesiredValue: 41 })).body.RequestedQuota
    expect(denied.Status).toBe('DENIED')
    expect((await call(D, 'GetServiceQuota', NACL_RULES)).body.Quota.Value).toBe(20)
    const allowed = (await call(D, 'RequestServiceQuotaIncrease', { ...NACL_RULES, DesiredValue: 40 })).body.RequestedQuota
    expect(allowed.Status).toBe('APPROVED')
    expect((await call(D, 'GetServiceQuota', NACL_RULES)).body.Quota.Value).toBe(40)
  })

  it('can leave requests pending until they are decided, or deny them', async () => {
    setApprovalPolicy(E, 'pending')
    const pending = (await call(E, 'RequestServiceQuotaIncrease', { ...VPCS, DesiredValue: 10 })).body.RequestedQuota
    expect(pending.Status).toBe('PENDING')
    expect((await call(E, 'GetServiceQuota', VPCS)).body.Quota.Value).toBe(5)
    // one open request per quota
    expect((await call(E, 'RequestServiceQuotaIncrease', { ...VPCS, DesiredValue: 11 })).body.__type).toBe('ResourceAlreadyExistsException')
    // another region is separate
    expect((await call(E, 'RequestServiceQuotaIncrease', { ...VPCS, DesiredValue: 11 }, 'eu-central-1')).body.RequestedQuota.Status).toBe('PENDING')

    decideRequest(E, pending.Id, 'APPROVED')
    expect((await call(E, 'GetServiceQuota', VPCS)).body.Quota.Value).toBe(10)
    expect((await call(E, 'GetServiceQuota', VPCS, 'eu-central-1')).body.Quota.Value).toBe(5)
    const fetched = (await call(E, 'GetRequestedServiceQuotaChange', { RequestId: pending.Id })).body.RequestedQuota
    expect(fetched.Status).toBe('APPROVED')
    expect(fetched.LastUpdated).toBeGreaterThanOrEqual(fetched.Created)
    expect((await call(E, 'GetRequestedServiceQuotaChange', { RequestId: pending.Id }, 'eu-central-1')).body.__type).toBe('NoSuchResourceException')

    setApprovalPolicy(E, 'deny')
    const refused = (await call(E, 'RequestServiceQuotaIncrease', { ...VPCS, DesiredValue: 20 })).body.RequestedQuota
    expect(refused.Status).toBe('DENIED')
    expect((await call(E, 'GetServiceQuota', VPCS)).body.Quota.Value).toBe(10)

    const history = (await call(E, 'ListRequestedServiceQuotaChangeHistory', {})).body.RequestedQuotas
    expect(history.map((r: any) => [r.DesiredValue, r.Status])).toEqual([[20, 'DENIED'], [10, 'APPROVED']])
    const approved = (await call(E, 'ListRequestedServiceQuotaChangeHistory', { Status: 'APPROVED' })).body.RequestedQuotas
    expect(approved.map((r: any) => r.Id)).toEqual([pending.Id])
    expect((await call(E, 'ListRequestedServiceQuotaChangeHistory', { ServiceCode: 'vpc' })).body.RequestedQuotas).toHaveLength(2)
    expect((await call(E, 'ListRequestedServiceQuotaChangeHistoryByQuota', VPCS)).body.RequestedQuotas).toHaveLength(2)
    expect((await call(E, 'ListRequestedServiceQuotaChangeHistoryByQuota', SUBNETS)).body.RequestedQuotas).toHaveLength(0)
    expect((await call(E, 'ListRequestedServiceQuotaChangeHistory', {}, 'eu-central-1')).body.RequestedQuotas).toHaveLength(1)
  })
})
