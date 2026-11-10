import { randomBytes } from "crypto"
import { quotaDefinitions, type QuotaDefinition } from "./db/reference"
import * as store from "./db/store"

// The one place that knows how many of something an account may have. Operations ask for the limit here instead of
// keeping their own constants. Defaults are reference data (data/aws/quotas.json); an account only stores the values
// that differ from the default (db/<account>/quotas.json). See docs/quotas-plan.md.

// Symbolic keys; each must have an entry in data/aws/quotas.json (checked by a test).
export const QUOTAS = {
  vpcsPerRegion: 'vpc.vpcs-per-region',
  subnetsPerVpc: 'vpc.subnets-per-vpc',
  ipv4CidrBlocksPerVpc: 'vpc.ipv4-cidr-blocks-per-vpc',
  networkAclsPerVpc: 'vpc.network-acls-per-vpc',
  rulesPerNetworkAcl: 'vpc.rules-per-network-acl',
  securityGroupsPerRegion: 'vpc.security-groups-per-region',
  rulesPerSecurityGroup: 'vpc.rules-per-security-group',
  elasticIpsPerRegion: 'ec2.elastic-ip-addresses-per-region',
  natGatewaysPerAvailabilityZone: 'vpc.nat-gateways-per-availability-zone',
  networkInterfacesPerRegion: 'vpc.network-interfaces-per-region',
  tagsPerResource: 'ec2.tags-per-resource',
  ouNestingDepth: 'organizations.ou-nesting-depth',
  scpMaxSize: 'organizations.scp-max-size',
  rcpMaxSize: 'organizations.rcp-max-size',
  lambdaTimeout: 'lambda.function-timeout',
  lambdaMemoryMin: 'lambda.function-memory-min',
  lambdaMemoryMax: 'lambda.function-memory-max',
  lambdaEnvironmentSize: 'lambda.environment-variables-size',
  lambdaPackageDirectSize: 'lambda.deployment-package-direct-size',
  lambdaPackageUnzippedSize: 'lambda.deployment-package-unzipped-size',
  lambdaPayloadSynchronous: 'lambda.invocation-payload-synchronous',
} as const

export type QuotaKey = (typeof QUOTAS)[keyof typeof QUOTAS]

export interface QuotaScope {
  account: string
  // Required for quotas that are per Region.
  region?: string
}

// What an account stores: overrides (quota key -> region, or '*' for a quota that is not per Region -> applied value),
// the quota increase requests it made, and how the simulator answers new requests.
interface QuotaOverrides {
  overrides: Record<string, Record<string, number>>
  requests?: Record<string, QuotaChangeRequest>
  approval?: ApprovalPolicy
}

// How requests for a quota increase are answered: approved at once (default), left pending until decideRequest, or denied.
export type ApprovalPolicy = 'auto' | 'pending' | 'deny'

export interface QuotaChangeRequest {
  Id: string
  Region: string
  Key: string
  DesiredValue: number
  Status: 'PENDING' | 'APPROVED' | 'DENIED' | 'NOT_APPROVED'
  Created: number
  LastUpdated: number
  Requester: string
}

const GLOBAL = '*'
const storeKey = (account: string): store.StoreKey => ({ service: 'quotas', account })

function definition(key: string): QuotaDefinition {
  const found = quotaDefinitions()[key]
  if (!found) {
    throw new Error(`Unknown quota '${key}'`)
  }
  return found
}

function regionOf(def: QuotaDefinition, key: string, scope: QuotaScope): string {
  if (def.global) {
    return GLOBAL
  }
  if (!scope.region) {
    throw new Error(`Quota '${key}' is per Region, so it needs a region`)
  }
  return scope.region
}

// The applied value for an account: its override, else the default.
export function quota(scope: QuotaScope, key: QuotaKey): number {
  const def = definition(key)
  if (!def.adjustable) {
    return def.default
  }
  const region = regionOf(def, key, scope)
  const overrides = store.read<QuotaOverrides>(storeKey(scope.account), { overrides: {} }).overrides
  return overrides[key]?.[region] ?? def.default
}

// A limit that AWS does not let anybody change, so no account is needed.
export function hardLimit(key: QuotaKey): number {
  const def = definition(key)
  if (def.adjustable) {
    throw new Error(`Quota '${key}' is adjustable, ask for it with quota()`)
  }
  return def.default
}

// Sets the applied value of an account (what an approved quota increase does, or a test of "what if this account only had 3").
export function setQuota(scope: QuotaScope, key: QuotaKey, value: number): void {
  const def = definition(key)
  if (!def.adjustable) {
    throw new Error(`Quota '${key}' cannot be changed`)
  }
  if (!Number.isInteger(value) || value < 0 || (def.maximum !== undefined && value > def.maximum)) {
    throw new Error(`Value ${value} is not valid for quota '${key}'${def.maximum === undefined ? '' : ` (maximum ${def.maximum})`}`)
  }
  const region = regionOf(def, key, scope)
  store.update<QuotaOverrides>(storeKey(scope.account), { overrides: {} }, state => {
    state.overrides[key] = { ...state.overrides[key], [region]: value }
  })
}

// Back to the default.
export function resetQuota(scope: QuotaScope, key: QuotaKey): void {
  const def = definition(key)
  const region = regionOf(def, key, scope)
  store.update<QuotaOverrides>(storeKey(scope.account), { overrides: {} }, state => {
    delete state.overrides[key]?.[region]
    if (state.overrides[key] && Object.keys(state.overrides[key]).length === 0) {
      delete state.overrides[key]
    }
  })
}

// ---------------------------------------------------------------------------
// quota increase requests (what the Service Quotas API creates)
// ---------------------------------------------------------------------------

export function approvalPolicy(account: string): ApprovalPolicy {
  return store.read<QuotaOverrides>(storeKey(account), { overrides: {} }).approval ?? 'auto'
}

export function setApprovalPolicy(account: string, policy: ApprovalPolicy): void {
  store.update<QuotaOverrides>(storeKey(account), { overrides: {} }, state => {
    state.approval = policy
  })
}

function applyOverride(state: QuotaOverrides, key: string, region: string, value: number) {
  state.overrides[key] = { ...state.overrides[key], [region]: value }
}

// Records a request and answers it as the account's approval policy says. An approved request applies the new value at once.
// The caller has checked that the quota is adjustable and the value higher than the current one.
export function requestIncrease(scope: Required<QuotaScope>, key: string, desired: number, requester: string): QuotaChangeRequest {
  const def = definition(key)
  const now = Date.now() / 1000
  const request: QuotaChangeRequest = {
    Id: randomBytes(16).toString('hex'),
    Region: scope.region,
    Key: key,
    DesiredValue: desired,
    Status: 'PENDING',
    Created: now,
    LastUpdated: now,
    Requester: requester,
  }
  store.update<QuotaOverrides>(storeKey(scope.account), { overrides: {} }, state => {
    const policy = state.approval ?? 'auto'
    // AWS does not raise a quota above its documented maximum without a different process; here it is simply denied.
    if (policy === 'deny' || (def.maximum !== undefined && desired > def.maximum)) {
      request.Status = 'DENIED'
    } else if (policy === 'auto') {
      request.Status = 'APPROVED'
      applyOverride(state, key, regionOf(def, key, scope), desired)
    }
    state.requests = { ...state.requests, [request.Id]: request }
  })
  return request
}

// Resolves a pending request (the simulator's stand-in for AWS Support answering a case).
export function decideRequest(account: string, id: string, status: 'APPROVED' | 'DENIED' | 'NOT_APPROVED'): QuotaChangeRequest {
  let decided: QuotaChangeRequest | undefined
  store.update<QuotaOverrides>(storeKey(account), { overrides: {} }, state => {
    const request = state.requests?.[id]
    if (!request) {
      throw new Error(`Unknown quota request '${id}'`)
    }
    if (request.Status !== 'PENDING') {
      throw new Error(`Quota request '${id}' is already ${request.Status}`)
    }
    request.Status = status
    request.LastUpdated = Date.now() / 1000
    if (status === 'APPROVED') {
      const def = definition(request.Key)
      applyOverride(state, request.Key, regionOf(def, request.Key, { account, region: request.Region }), request.DesiredValue)
    }
    decided = request
  })
  return decided!
}

export function quotaRequests(account: string): QuotaChangeRequest[] {
  return Object.values(store.read<QuotaOverrides>(storeKey(account), { overrides: {} }).requests ?? {})
    .sort((a, b) => b.Created - a.Created)
}
