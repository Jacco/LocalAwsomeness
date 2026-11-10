import { randomBytes } from "crypto"
import { AwsError } from "../common"
import { QUOTAS, hardLimit } from "../quotas"
import { attachRolePolicy, createRole, type PolicyDocument } from "./iam"
import { defaultOrganizationPolicies } from "./reference"
import { provisionAccount } from "./ec2/state"
import * as store from "./store"

// *****************************************************************************
// ***                                                                       ***
// *** Account registry (db/accounts.json)                                   ***
// ***                                                                       ***
// *****************************************************************************

const ACCOUNTS_KEY: store.StoreKey = { service: 'accounts' }

export interface AccountRecord {
  id: string
  name: string
  email: string
  joinMethod: 'CREATED' | 'INVITED'
  joinedTimestamp: number
  requestedTimestamp: number
}

const DIGITS = '0123456789'
const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomId(length: number, chars: string = LOWER_ALNUM): string {
  return Array.from(randomBytes(length), b => chars[b % chars.length]).join('')
}

function loadAccounts(): AccountRecord[] {
  return store.read<AccountRecord[]>(ACCOUNTS_KEY, [])
}

export function getAccount(id: string): AccountRecord {
  const account = loadAccounts().find(x => x.id === id)
  if (!account) {
    throw new AwsError('ResourceNotFoundException', "Account not found", 404)
  }
  return account
}

export function accountExists(id: string): boolean {
  return loadAccounts().some(x => x.id === id)
}

export function emailInUse(email: string): boolean {
  return loadAccounts().some(x => x.email.toLowerCase() === email.toLowerCase())
}

export function registerAccount(name: string, email: string, joinMethod: AccountRecord['joinMethod'] = 'CREATED'): AccountRecord {
  const accounts = loadAccounts()
  let id = randomId(12, DIGITS)
  while (accounts.some(x => x.id === id) || store.accountDirExists(id)) {
    id = randomId(12, DIGITS)
  }
  const now = Date.now()
  const account: AccountRecord = { id, name, email, joinMethod, joinedTimestamp: now, requestedTimestamp: now }
  accounts.push(account)
  store.write(ACCOUNTS_KEY, accounts)
  store.write({ service: 'account', account: id }, {})
  provisionAccount(id)
  return account
}

// *****************************************************************************
// ***                                                                       ***
// *** Organization state (db/<managementAccount>/organization.json)         ***
// ***                                                                       ***
// *****************************************************************************

export const SCP = 'SERVICE_CONTROL_POLICY'
export const RCP = 'RESOURCE_CONTROL_POLICY'
export const POLICY_TYPES = [
  SCP, RCP, 'TAG_POLICY', 'BACKUP_POLICY', 'AISERVICES_OPT_OUT_POLICY', 'CHATBOT_POLICY',
  'DECLARATIVE_POLICY_EC2', 'SECURITYHUB_POLICY', 'INSPECTOR_POLICY', 'UPGRADE_ROLLOUT_POLICY',
  'BEDROCK_POLICY', 'S3_POLICY', 'NETWORK_SECURITY_DIRECTOR_POLICY'
]

export interface Policy {
  id: string
  name: string
  description: string
  type: string
  awsManaged: boolean
  content: PolicyDocument
}

// SCPs and RCPs must always have at least one policy attached; AWS attaches a default allow-all on enable.
const DEFAULT_POLICIES: Record<string, Policy> = Object.fromEntries(
  Object.entries(defaultOrganizationPolicies()).map(([type, p]) => [type, { ...p, type, awsManaged: true }])
)

export interface OrgUnit {
  id: string
  name: string
  parentId: string
}

export interface Member {
  parentId: string
  joinedMethod: 'CREATED' | 'INVITED'
  joinedTimestamp: number
  state: 'ACTIVE' | 'PENDING_CLOSURE' | 'SUSPENDED' | 'CLOSED'
  roleName?: string
}

export interface CreateAccountRequest {
  id: string
  accountName: string
  accountId?: string
  state: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED'
  failureReason?: string
  requestedTimestamp: number
  completedTimestamp?: number
}

export interface OrgState {
  id: string
  featureSet: 'ALL' | 'CONSOLIDATED_BILLING'
  managementAccountId: string
  rootId: string
  policyTypes: string[]
  ous: Record<string, OrgUnit>
  members: Record<string, Member>
  policies: Record<string, Policy>
  attachments: Record<string, string[]>
  createAccountRequests: Record<string, CreateAccountRequest>
}

export type TargetType = 'ROOT' | 'ORGANIZATIONAL_UNIT' | 'ACCOUNT'

const orgKey = (managementAccountId: string): store.StoreKey => ({ service: 'organization', account: managementAccountId })

function saveOrg(org: OrgState) {
  store.write(orgKey(org.managementAccountId), org)
}

export function findOrg(accountId: string): OrgState | undefined {
  for (const dir of store.listAccountDirs()) {
    const org = store.read<OrgState | undefined>(orgKey(dir), undefined)
    if (org && accountId in org.members) {
      return org
    }
  }
  return undefined
}

export function requireOrg(accountId: string): OrgState {
  const org = findOrg(accountId)
  if (!org) {
    throw new AwsError('AWSOrganizationsNotInUseException', 'Your account is not a member of an organization.')
  }
  return org
}

export function requireManagement(accountId: string): OrgState {
  const org = requireOrg(accountId)
  if (org.managementAccountId !== accountId) {
    throw new AwsError('AccessDeniedException', "You don't have permissions to access this resource.")
  }
  return org
}

export function targetType(org: OrgState, id: string): TargetType | undefined {
  if (id === org.rootId) return 'ROOT'
  if (org.ous[id]) return 'ORGANIZATIONAL_UNIT'
  if (id in org.members) return 'ACCOUNT'
  return undefined
}

export function getPolicy(org: OrgState, id: string): Policy {
  const policy = org.policies[id] ?? Object.values(DEFAULT_POLICIES).find(p => p.id === id)
  if (!policy) {
    throw new AwsError('PolicyNotFoundException', "You specified a policy that doesn't exist.")
  }
  return policy
}

export function listPolicies(org: OrgState, type: string): Policy[] {
  assertPolicyType(type)
  const aws = DEFAULT_POLICIES[type] ? [DEFAULT_POLICIES[type]] : []
  return [...aws, ...Object.values(org.policies).filter(p => p.type === type)]
}

function assertPolicyType(type: string) {
  if (!POLICY_TYPES.includes(type)) {
    throw new AwsError('InvalidInputException', `You specified an invalid value for PolicyType: ${type}`)
  }
}

function assertTarget(org: OrgState, id: string): TargetType {
  const type = targetType(org, id)
  if (!type) {
    throw new AwsError('TargetNotFoundException', "We can't find a root, OU, or account with the TargetId you specified.")
  }
  return type
}

function assertParent(org: OrgState, id: string) {
  if (id !== org.rootId && !org.ous[id]) {
    throw new AwsError('ParentNotFoundException', "We can't find a root or OU with the ParentId that you specified.")
  }
}

function attachDefaults(org: OrgState, targetId: string) {
  for (const type of org.policyTypes) {
    const def = DEFAULT_POLICIES[type]
    if (def) {
      org.attachments[targetId] = [...(org.attachments[targetId] ?? []), def.id]
    }
  }
}

// *****************************************************************************
// ***                                                                       ***
// *** Organization                                                          ***
// ***                                                                       ***
// *****************************************************************************

export function createOrganization(callerAccountId: string, featureSet: string = 'ALL'): OrgState {
  if (featureSet !== 'ALL' && featureSet !== 'CONSOLIDATED_BILLING') {
    throw new AwsError('InvalidInputException', `You specified an invalid value for FeatureSet: ${featureSet}`)
  }
  if (findOrg(callerAccountId)) {
    throw new AwsError('AlreadyInOrganizationException', 'This account is already a member of an organization.')
  }
  if (!accountExists(callerAccountId)) {
    throw new AwsError('AccessDeniedException', "You don't have permissions to access this resource.")
  }
  const rootId = 'r-' + randomId(4)
  const org: OrgState = {
    id: 'o-' + randomId(10),
    featureSet,
    managementAccountId: callerAccountId,
    rootId,
    policyTypes: [],
    ous: {},
    members: {
      [callerAccountId]: { parentId: rootId, joinedMethod: 'CREATED', joinedTimestamp: Date.now(), state: 'ACTIVE' }
    },
    policies: {},
    attachments: {},
    createAccountRequests: {}
  }
  saveOrg(org)
  return org
}

export function deleteOrganization(org: OrgState) {
  if (Object.keys(org.members).length > 1 || Object.keys(org.ous).length > 0) {
    throw new AwsError('OrganizationNotEmptyException', 'The organization still contains accounts or OUs.')
  }
  store.remove(orgKey(org.managementAccountId))
}

export function enablePolicyType(org: OrgState, rootId: string, type: string) {
  assertPolicyType(type)
  if (rootId !== org.rootId) {
    throw new AwsError('RootNotFoundException', "We can't find a root with the RootId you specified.")
  }
  if (org.featureSet !== 'ALL') {
    throw new AwsError('PolicyTypeNotAvailableForOrganizationException', 'This policy type requires all features to be enabled in the organization.')
  }
  if (org.policyTypes.includes(type)) {
    throw new AwsError('PolicyTypeAlreadyEnabledException', 'The specified policy type is already enabled in the specified root.')
  }
  org.policyTypes.push(type)
  for (const id of [org.rootId, ...Object.keys(org.ous), ...Object.keys(org.members)]) {
    if (DEFAULT_POLICIES[type]) {
      org.attachments[id] = [...(org.attachments[id] ?? []), DEFAULT_POLICIES[type].id]
    }
  }
  saveOrg(org)
}

export function disablePolicyType(org: OrgState, rootId: string, type: string) {
  assertPolicyType(type)
  if (rootId !== org.rootId) {
    throw new AwsError('RootNotFoundException', "We can't find a root with the RootId you specified.")
  }
  if (!org.policyTypes.includes(type)) {
    throw new AwsError('PolicyTypeNotEnabledException', "The specified policy type isn't currently enabled in this root.")
  }
  org.policyTypes = org.policyTypes.filter(t => t !== type)
  for (const target of Object.keys(org.attachments)) {
    org.attachments[target] = org.attachments[target].filter(id => getPolicy(org, id).type !== type)
  }
  saveOrg(org)
}

// *****************************************************************************
// ***                                                                       ***
// *** Organizational units and accounts                                     ***
// ***                                                                       ***
// *****************************************************************************

function ouDepth(org: OrgState, parentId: string): number {
  let depth = 1
  for (let p = parentId; p !== org.rootId; p = org.ous[p].parentId) {
    depth++
  }
  return depth
}

export function childrenOf(org: OrgState, parentId: string): { ous: OrgUnit[], accounts: string[] } {
  return {
    ous: Object.values(org.ous).filter(x => x.parentId === parentId),
    accounts: Object.entries(org.members).filter(x => x[1].parentId === parentId).map(x => x[0])
  }
}

export function createOrganizationalUnit(org: OrgState, parentId: string, name: string): OrgUnit {
  assertParent(org, parentId)
  if (childrenOf(org, parentId).ous.some(x => x.name === name)) {
    throw new AwsError('DuplicateOrganizationalUnitException', 'An OU with the same name already exists.')
  }
  // ouDepth counts the root as level 1, the OU to create goes one level below its parent.
  if (ouDepth(org, parentId) > hardLimit(QUOTAS.ouNestingDepth)) {
    throw new AwsError('ConstraintViolationException', 'MAX_OU_DEPTH: You exceeded the number of levels of OUs.')
  }
  const ou: OrgUnit = { id: `ou-${org.rootId.substring(2)}-${randomId(8)}`, name, parentId }
  org.ous[ou.id] = ou
  attachDefaults(org, ou.id)
  saveOrg(org)
  return ou
}

export function getOrganizationalUnit(org: OrgState, id: string): OrgUnit {
  const ou = org.ous[id]
  if (!ou) {
    throw new AwsError('OrganizationalUnitNotFoundException', "We can't find an OU with the OrganizationalUnitId that you specified.")
  }
  return ou
}

export function updateOrganizationalUnit(org: OrgState, id: string, name: string): OrgUnit {
  const ou = getOrganizationalUnit(org, id)
  if (childrenOf(org, ou.parentId).ous.some(x => x.name === name && x.id !== id)) {
    throw new AwsError('DuplicateOrganizationalUnitException', 'An OU with the same name already exists.')
  }
  ou.name = name
  saveOrg(org)
  return ou
}

export function deleteOrganizationalUnit(org: OrgState, id: string) {
  const ou = getOrganizationalUnit(org, id)
  const children = childrenOf(org, ou.id)
  if (children.ous.length > 0 || children.accounts.length > 0) {
    throw new AwsError('OrganizationalUnitNotEmptyException', 'The specified OU is not empty.')
  }
  delete org.ous[id]
  delete org.attachments[id]
  saveOrg(org)
}

export function createAccountRequest(org: OrgState, name: string, email: string, roleName?: string): CreateAccountRequest {
  const now = Date.now()
  const request: CreateAccountRequest = {
    id: 'car-' + randomId(32),
    accountName: name,
    state: 'IN_PROGRESS',
    requestedTimestamp: now
  }
  if (emailInUse(email)) {
    request.state = 'FAILED'
    request.failureReason = 'EMAIL_ALREADY_EXISTS'
  } else {
    const account = registerAccount(name, email)
    const accessRole = roleName ?? 'OrganizationAccountAccessRole'
    org.members[account.id] = {
      parentId: org.rootId,
      joinedMethod: 'CREATED',
      joinedTimestamp: now,
      state: 'ACTIVE',
      roleName: accessRole
    }
    createRole(account.id, {
      roleName: accessRole,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${org.managementAccountId}:root` }, Action: 'sts:AssumeRole' }]
      }
    })
    attachRolePolicy(account.id, accessRole, 'arn:aws:iam::aws:policy/AdministratorAccess')
    attachDefaults(org, account.id)
    request.accountId = account.id
    request.state = 'SUCCEEDED'
  }
  request.completedTimestamp = Date.now()
  org.createAccountRequests[request.id] = request
  saveOrg(org)
  return request
}

export function getCreateAccountRequest(org: OrgState, id: string): CreateAccountRequest {
  const request = org.createAccountRequests[id]
  if (!request) {
    throw new AwsError('CreateAccountStatusNotFoundException', "We can't find an create account request with the CreateAccountRequestId that you specified.")
  }
  return request
}

export function assertMember(org: OrgState, accountId: string): Member {
  const member = org.members[accountId]
  if (!member) {
    throw new AwsError('AccountNotFoundException', "We can't find an AWS account with the AccountId that you specified, or the account whose credentials you used to make this request isn't a member of an organization.")
  }
  return member
}

export function moveAccount(org: OrgState, accountId: string, sourceParentId: string, destinationParentId: string) {
  const member = assertMember(org, accountId)
  assertParent(org, destinationParentId)
  if (member.parentId !== sourceParentId) {
    throw new AwsError('SourceParentNotFoundException', "We can't find a source root or OU with the ParentId that you specified.")
  }
  if (sourceParentId === destinationParentId) {
    throw new AwsError('DuplicateAccountException', 'That account is already present in the specified destination.')
  }
  member.parentId = destinationParentId
  saveOrg(org)
}

export function closeAccount(org: OrgState, accountId: string) {
  const member = assertMember(org, accountId)
  if (accountId === org.managementAccountId) {
    throw new AwsError('ConstraintViolationException', 'MASTER_ACCOUNT_MISSING_CONTACT_INFO: The management account cannot be closed.')
  }
  member.state = 'PENDING_CLOSURE'
  saveOrg(org)
}

export function parentOf(org: OrgState, childId: string): { id: string, type: 'ROOT' | 'ORGANIZATIONAL_UNIT' } {
  const parentId = org.members[childId]?.parentId ?? org.ous[childId]?.parentId
  if (!parentId) {
    throw new AwsError('ChildNotFoundException', "We can't find an organizational unit (OU) or AWS account with the ChildId that you specified.")
  }
  return { id: parentId, type: parentId === org.rootId ? 'ROOT' : 'ORGANIZATIONAL_UNIT' }
}

// *****************************************************************************
// ***                                                                       ***
// *** Policies                                                              ***
// ***                                                                       ***
// *****************************************************************************

function parsePolicyContent(type: string, content: string): PolicyDocument {
  let doc: any
  try {
    doc = JSON.parse(content)
  } catch {
    throw new AwsError('MalformedPolicyDocumentException', 'The provided policy document does not meet the requirements of the specified policy type.')
  }
  if (type === SCP || type === RCP) {
    if (typeof doc !== 'object' || doc === null || !('Statement' in doc)) {
      throw new AwsError('MalformedPolicyDocumentException', 'The provided policy document does not meet the requirements of the specified policy type.')
    }
    if (content.length > hardLimit(type === SCP ? QUOTAS.scpMaxSize : QUOTAS.rcpMaxSize)) {
      throw new AwsError('ConstraintViolationException', 'POLICY_CONTENT_LIMIT_EXCEEDED: You exceeded the maximum size of the policy content.')
    }
  }
  return doc
}

export function createPolicy(org: OrgState, name: string, description: string, type: string, content: string): Policy {
  assertPolicyType(type)
  if (!org.policyTypes.includes(type)) {
    throw new AwsError('PolicyTypeNotEnabledException', "The specified policy type isn't currently enabled in this root.")
  }
  const document = parsePolicyContent(type, content)
  if (listPolicies(org, type).some(p => p.name === name)) {
    throw new AwsError('DuplicatePolicyException', 'A policy with the same name already exists.')
  }
  const policy: Policy = { id: 'p-' + randomId(10), name, description, type, awsManaged: false, content: document }
  org.policies[policy.id] = policy
  saveOrg(org)
  return policy
}

export function updatePolicy(org: OrgState, id: string, changes: { name?: string, description?: string, content?: string }): Policy {
  const policy = getPolicy(org, id)
  if (policy.awsManaged) {
    throw new AwsError('AccessDeniedException', "You can't modify or delete AWS managed policies.")
  }
  if (changes.content !== undefined) {
    policy.content = parsePolicyContent(policy.type, changes.content)
  }
  if (changes.name !== undefined) {
    if (listPolicies(org, policy.type).some(p => p.name === changes.name && p.id !== id)) {
      throw new AwsError('DuplicatePolicyException', 'A policy with the same name already exists.')
    }
    policy.name = changes.name
  }
  if (changes.description !== undefined) {
    policy.description = changes.description
  }
  saveOrg(org)
  return policy
}

export function deletePolicy(org: OrgState, id: string) {
  const policy = getPolicy(org, id)
  if (policy.awsManaged) {
    throw new AwsError('AccessDeniedException', "You can't modify or delete AWS managed policies.")
  }
  if (targetsForPolicy(org, id).length > 0) {
    throw new AwsError('PolicyInUseException', 'The policy is attached to one or more entities. You must detach it from all roots, OUs, and accounts before performing this operation.')
  }
  delete org.policies[id]
  saveOrg(org)
}

export function attachPolicy(org: OrgState, policyId: string, targetId: string) {
  const policy = getPolicy(org, policyId)
  assertTarget(org, targetId)
  if (!org.policyTypes.includes(policy.type)) {
    throw new AwsError('PolicyTypeNotEnabledException', "The specified policy type isn't currently enabled in this root.")
  }
  const attached = org.attachments[targetId] ?? []
  if (attached.includes(policyId)) {
    throw new AwsError('DuplicatePolicyAttachmentException', 'The selected policy is already attached to the specified target.')
  }
  org.attachments[targetId] = [...attached, policyId]
  saveOrg(org)
}

export function detachPolicy(org: OrgState, policyId: string, targetId: string) {
  const policy = getPolicy(org, policyId)
  assertTarget(org, targetId)
  const attached = org.attachments[targetId] ?? []
  if (!attached.includes(policyId)) {
    throw new AwsError('PolicyNotAttachedException', "The policy you're trying to detach isn't attached to the specified target.")
  }
  if (DEFAULT_POLICIES[policy.type] && policiesForTarget(org, targetId, policy.type).length <= 1) {
    throw new AwsError('ConstraintViolationException', 'MIN_POLICY_ATTACHMENT_LIMIT_EXCEEDED: You must have at least one policy of this type attached to every target.')
  }
  org.attachments[targetId] = attached.filter(x => x !== policyId)
  saveOrg(org)
}

export function policiesForTarget(org: OrgState, targetId: string, type: string): Policy[] {
  assertPolicyType(type)
  assertTarget(org, targetId)
  return (org.attachments[targetId] ?? []).map(id => getPolicy(org, id)).filter(p => p.type === type)
}

export function targetsForPolicy(org: OrgState, policyId: string): { id: string, type: TargetType, name: string }[] {
  getPolicy(org, policyId)
  return Object.entries(org.attachments)
    .filter(x => x[1].includes(policyId))
    .map(x => x[0])
    .map(id => ({ id, type: targetType(org, id)!, name: nameOfTarget(org, id) }))
}

export function nameOfTarget(org: OrgState, id: string): string {
  switch (targetType(org, id)) {
    case 'ROOT': return 'Root'
    case 'ORGANIZATIONAL_UNIT': return org.ous[id].name
    default: return accountExists(id) ? getAccount(id).name : id
  }
}

// *****************************************************************************
// ***                                                                       ***
// *** Policy evaluation support                                             ***
// ***                                                                       ***
// *****************************************************************************

export interface HierarchyLevel {
  id: string
  type: TargetType
  policies: Policy[]
}

/**
 * Policies of the given type that apply to an account, ordered from the root down to the account.
 * An action is allowed by SCPs only if every level allows it. Returns undefined if the account is
 * not in an organization or the policy type is not enabled (no restrictions apply).
 */
export function policyHierarchy(accountId: string, type: string = SCP): HierarchyLevel[] | undefined {
  const org = findOrg(accountId)
  if (!org || !org.policyTypes.includes(type)) {
    return undefined
  }
  const chain = [accountId]
  for (let p = org.members[accountId].parentId; p !== org.rootId; p = org.ous[p].parentId) {
    chain.unshift(p)
  }
  chain.unshift(org.rootId)
  return chain.map(id => ({ id, type: targetType(org, id)!, policies: policiesForTarget(org, id, type) }))
}
