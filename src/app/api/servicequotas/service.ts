import { AwsError } from "../common"
import { PARTITION } from "../db/common"
import { quotaDefinitions, quotaServiceNames, type QuotaDefinition } from "../db/reference"
import { JsonProtocol } from "../protocols"
import { quota, quotaRequests, requestIncrease, type QuotaChangeRequest, type QuotaKey } from "../quotas"
import { defineService, type RequestContext } from "../registry"

// The Service Quotas API over the quota registry (src/app/api/quotas.ts). Only quotas that have a Service Quotas code are
// listed; hard limits (tags per resource, SCP size, ...) are not in the real API either. Enforcement does not call
// this API: it asks the registry directly, which is the same source this API reads.

interface Listed {
  key: string
  def: QuotaDefinition
}

const listed = (): Listed[] =>
  Object.entries(quotaDefinitions()).filter(([, def]) => def.code !== null).map(([key, def]) => ({ key, def }))

const noSuchResource = () => new AwsError('NoSuchResourceException', 'The specified resource does not exist.')
const illegal = (message: string) => new AwsError('IllegalArgumentException', message)

function findListed(serviceCode: string | undefined, quotaCode: string | undefined): Listed {
  if (!serviceCode) {
    throw illegal('ServiceCode is required')
  }
  if (!quotaCode) {
    throw illegal('QuotaCode is required')
  }
  const found = listed().find(({ def }) => def.service === serviceCode && def.code === quotaCode)
  if (!found) {
    throw noSuchResource()
  }
  return found
}

function requireService(serviceCode: string | undefined): string {
  if (!serviceCode) {
    throw illegal('ServiceCode is required')
  }
  if (!listed().some(({ def }) => def.service === serviceCode)) {
    throw noSuchResource()
  }
  return serviceCode
}

const quotaArn = ({ account, region }: RequestContext, def: QuotaDefinition) =>
  `arn:${PARTITION}:servicequotas:${region}:${account}:${def.service}/${def.code}`

// Only whole pages and base64 offsets; MaxResults is 1 to 100.
function paginate<T>(items: T[], params: { MaxResults?: number; NextToken?: string }): { items: T[]; NextToken?: string } {
  const size = params.MaxResults ?? 100
  if (!Number.isInteger(size) || size < 1 || size > 100) {
    throw illegal(`MaxResults must be between 1 and 100, got ${params.MaxResults}`)
  }
  let start = 0
  if (params.NextToken !== undefined) {
    start = Number(Buffer.from(params.NextToken, 'base64').toString())
    if (!Number.isInteger(start) || start < 0) {
      throw new AwsError('InvalidPaginationTokenException', 'Invalid NextToken')
    }
  }
  const page = items.slice(start, start + size)
  return start + size < items.length
    ? { items: page, NextToken: Buffer.from(String(start + size)).toString('base64') }
    : { items: page }
}

function serviceQuota(ctx: RequestContext, { key, def }: Listed, applied: boolean) {
  return {
    ServiceCode: def.service,
    ServiceName: quotaServiceNames()[def.service],
    QuotaArn: quotaArn(ctx, def),
    QuotaCode: def.code,
    QuotaName: def.name,
    Value: applied ? quota({ account: ctx.account, region: ctx.region }, key as QuotaKey) : def.default,
    Unit: def.unit,
    Adjustable: def.adjustable,
    GlobalQuota: def.global,
    ...(applied ? { QuotaAppliedAtLevel: 'ACCOUNT' } : {}),
  }
}

function requestView(ctx: RequestContext, request: QuotaChangeRequest) {
  const { def } = findListed(quotaDefinitions()[request.Key].service, quotaDefinitions()[request.Key].code!)
  return {
    Id: request.Id,
    ServiceCode: def.service,
    ServiceName: quotaServiceNames()[def.service],
    QuotaCode: def.code,
    QuotaName: def.name,
    DesiredValue: request.DesiredValue,
    Status: request.Status,
    Created: request.Created,
    LastUpdated: request.LastUpdated,
    Requester: request.Requester,
    QuotaArn: quotaArn(ctx, def),
    GlobalQuota: def.global,
    Unit: def.unit,
    QuotaRequestedAtLevel: 'ACCOUNT',
  }
}

const quotaResource = ({ account, region, params }: RequestContext) => {
  const found = listed().find(({ def }) => def.service === params.ServiceCode && def.code === params.QuotaCode)
  return [found ? quotaArn({ account, region } as RequestContext, found.def) : `arn:${PARTITION}:servicequotas:${region}:${account}:*`]
}

export const servicequotas = defineService({
  iamPrefix: 'servicequotas',
  protocol: new JsonProtocol('1.1', 'SerializationException'),
  operations: {
    ListServices: ({ params }) => {
      const services = [...new Set(listed().map(({ def }) => def.service))].sort()
        .map(code => ({ ServiceCode: code, ServiceName: quotaServiceNames()[code] }))
      const { items, NextToken } = paginate(services, params)
      return { Services: items, NextToken }
    },

    // The applied values of the account: its overrides, else the defaults.
    ListServiceQuotas: ctx => {
      const serviceCode = requireService(ctx.params.ServiceCode)
      // Quotas applied at resource level do not exist here.
      const all = ctx.params.QuotaAppliedAtLevel === 'RESOURCE' ? [] : listed()
      const quotas = all
        .filter(({ def }) => def.service === serviceCode && (!ctx.params.QuotaCode || def.code === ctx.params.QuotaCode))
        .map(entry => serviceQuota(ctx, entry, true))
      const { items, NextToken } = paginate(quotas, ctx.params)
      return { Quotas: items, NextToken }
    },

    GetServiceQuota: {
      handler: ctx => ({ Quota: serviceQuota(ctx, findListed(ctx.params.ServiceCode, ctx.params.QuotaCode), true) }),
      resources: quotaResource,
    },

    ListAWSDefaultServiceQuotas: ctx => {
      const serviceCode = requireService(ctx.params.ServiceCode)
      const quotas = listed().filter(({ def }) => def.service === serviceCode).map(entry => serviceQuota(ctx, entry, false))
      const { items, NextToken } = paginate(quotas, ctx.params)
      return { Quotas: items, NextToken }
    },

    GetAWSDefaultServiceQuota: {
      handler: ctx => ({ Quota: serviceQuota(ctx, findListed(ctx.params.ServiceCode, ctx.params.QuotaCode), false) }),
      resources: quotaResource,
    },

    RequestServiceQuotaIncrease: {
      handler: ctx => {
        const entry = findListed(ctx.params.ServiceCode, ctx.params.QuotaCode)
        const desired = ctx.params.DesiredValue
        if (typeof desired !== 'number' || !Number.isFinite(desired)) {
          throw illegal('DesiredValue is required')
        }
        const scope = { account: ctx.account, region: ctx.region }
        if (!entry.def.adjustable) {
          throw illegal('This quota cannot be increased')
        }
        if (desired <= quota(scope, entry.key as QuotaKey)) {
          throw illegal('DesiredValue must be greater than the current value of the quota')
        }
        if (quotaRequests(ctx.account).some(r => r.Key === entry.key && r.Region === ctx.region && r.Status === 'PENDING')) {
          throw new AwsError('ResourceAlreadyExistsException', 'A request for this quota is already pending.')
        }
        return { RequestedQuota: requestView(ctx, requestIncrease(scope, entry.key, desired, ctx.principal)) }
      },
      resources: quotaResource,
    },

    GetRequestedServiceQuotaChange: ctx => {
      const request = quotaRequests(ctx.account).find(r => r.Id === ctx.params.RequestId && r.Region === ctx.region)
      if (!request) {
        throw noSuchResource()
      }
      return { RequestedQuota: requestView(ctx, request) }
    },

    ListRequestedServiceQuotaChangeHistory: ctx => {
      const { ServiceCode, Status, QuotaRequestedAtLevel } = ctx.params
      if (ServiceCode !== undefined) {
        requireService(ServiceCode)
      }
      const requests = QuotaRequestedAtLevel === 'RESOURCE' ? [] : quotaRequests(ctx.account)
        .filter(r => r.Region === ctx.region)
        .map(r => requestView(ctx, r))
        .filter(r => (ServiceCode === undefined || r.ServiceCode === ServiceCode) && (Status === undefined || r.Status === Status))
      const { items, NextToken } = paginate(requests, ctx.params)
      return { RequestedQuotas: items, NextToken }
    },

    ListRequestedServiceQuotaChangeHistoryByQuota: ctx => {
      const entry = findListed(ctx.params.ServiceCode, ctx.params.QuotaCode)
      const requests = quotaRequests(ctx.account)
        .filter(r => r.Region === ctx.region && r.Key === entry.key && (ctx.params.Status === undefined || r.Status === ctx.params.Status))
        .map(r => requestView(ctx, r))
      const { items, NextToken } = paginate(requests, ctx.params)
      return { RequestedQuotas: items, NextToken }
    },
  },
})
