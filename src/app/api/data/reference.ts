import { readFileSync } from "fs"

// Read-only data that AWS itself provides, shipped with the repo and never written by API calls.
// Managed policies are regenerated from a real account with getpolicies.py.
const DATA = 'data/aws'

export type PolicyDocument = Record<string, any>

export interface ManagedPolicy {
  name: string
  path: string
  arn: string
  policyId: string
  description?: string
  defaultVersion: string
  versions: string[]
  // Only the default version is stored.
  documents: Record<string, PolicyDocument>
}

interface RawManagedPolicy {
  Versions: string[]
  PolicyId: string
  DefaultVersion: string
  Description?: string
  Document: Record<string, PolicyDocument>
}

export interface OrganizationPolicyDefinition {
  id: string
  name: string
  description: string
  content: PolicyDocument
}

function readData<T>(file: string): T {
  return JSON.parse(readFileSync(`${DATA}/${file}`).toString())
}

let managedPolicies: Map<string, ManagedPolicy> | undefined

// Keys in managed-policies.json are the ARN part after "policy/", e.g. "service-role/AWSLambdaRole".
function loadManagedPolicies(): Map<string, ManagedPolicy> {
  if (!managedPolicies) {
    managedPolicies = new Map()
    for (const [key, raw] of Object.entries(readData<Record<string, RawManagedPolicy>>('managed-policies.json'))) {
      const slash = key.lastIndexOf('/')
      const policy: ManagedPolicy = {
        name: key.slice(slash + 1),
        path: slash < 0 ? '/' : `/${key.slice(0, slash + 1)}`,
        arn: `arn:aws:iam::aws:policy/${key}`,
        policyId: raw.PolicyId,
        description: raw.Description,
        defaultVersion: raw.DefaultVersion,
        versions: raw.Versions,
        documents: raw.Document
      }
      managedPolicies.set(policy.arn, policy)
    }
  }
  return managedPolicies
}

export function listManagedPolicies(): ManagedPolicy[] {
  return [...loadManagedPolicies().values()]
}

export function findManagedPolicy(arn: string): ManagedPolicy | undefined {
  return loadManagedPolicies().get(arn)
}

// Keyed by policy type; AWS attaches these to every root, OU and account when the type is enabled.
export function defaultOrganizationPolicies(): Record<string, OrganizationPolicyDefinition> {
  return readData('organizations-policies.json')
}

// A default quota or hard limit. `code` is the Service Quotas quota code (null for limits Service Quotas does not list).
export interface QuotaDefinition {
  service: string
  name: string
  code: string | null
  default: number
  // The highest value a quota increase can reach, when AWS documents one.
  maximum?: number
  adjustable: boolean
  // Not per Region.
  global: boolean
  unit: string
  note?: string
  source: string
  checked: string
}

let quotas: Record<string, QuotaDefinition> | undefined

// Keyed by the symbolic quota key (`vpc.vpcs-per-region`), see src/app/api/quotas.ts.
export function quotaDefinitions(): Record<string, QuotaDefinition> {
  if (!quotas) {
    quotas = readData<Record<string, QuotaDefinition>>('quotas.json')
  }
  return quotas
}

let quotaServices: Record<string, string> | undefined

// Service code -> service name, as Service Quotas lists them.
export function quotaServiceNames(): Record<string, string> {
  if (!quotaServices) {
    quotaServices = readData<Record<string, string>>('quota-services.json')
  }
  return quotaServices
}
