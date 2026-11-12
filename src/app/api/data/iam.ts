
// *****************************************************************************
// ***                                                                       ***
// *** IAM                                                                   ***
// ***                                                                       ***
// *****************************************************************************

import { AwsError, generateIamId } from "../common"
import { findManagedPolicy, listManagedPolicies, type ManagedPolicy, type PolicyDocument } from "./reference"
import * as store from "./store"

export type { PolicyDocument }

export enum PolicyScope {
  All = "All",
  AWS = "AWS",
  Local = "Local",
}

// Customer-managed policies are not implemented yet, so Local is always empty.
export function listPolicies(account: string, scope: PolicyScope = PolicyScope.All, pathPrefix: string = '/'): ManagedPolicy[] {
  const policies = scope === PolicyScope.Local ? [] : listManagedPolicies()
  return policies.filter(p => p.path.startsWith(pathPrefix))
}

// *****************************************************************************
// ***                                                                       ***
// *** Roles (db/<account>/iam.json)                                         ***
// ***                                                                       ***
// *****************************************************************************

export interface Role {
  roleName: string
  roleId: string
  path: string
  arn: string
  createDate: number
  assumeRolePolicyDocument: PolicyDocument
  description?: string
  maxSessionDuration: number
  inlinePolicies: Record<string, PolicyDocument>
  attachedPolicies: string[]
}

interface IamState {
  roles: Record<string, Role>
}

const NAME_PATTERN = /^[\w+=,.@-]{1,64}$/

const iamKey = (account: string): store.StoreKey => ({ service: 'iam', account })

function loadIam(account: string): IamState {
  return store.read<IamState>(iamKey(account), { roles: {} })
}

function saveIam(account: string, state: IamState) {
  store.write(iamKey(account), state)
}

function validationError(message: string): never {
  throw new AwsError('ValidationError', message)
}

export function parsePolicyDocument(document: string): PolicyDocument {
  try {
    const parsed = JSON.parse(document)
    if (typeof parsed !== 'object' || parsed === null || !('Statement' in parsed)) {
      throw Error()
    }
    return parsed
  } catch {
    throw new AwsError('MalformedPolicyDocument', 'Syntax errors in policy.')
  }
}

function noSuchRole(roleName: string): AwsError {
  return new AwsError('NoSuchEntity', `The role with name ${roleName} cannot be found.`, 404)
}

export function getRole(account: string, roleName: string): Role {
  const role = loadIam(account).roles[roleName]
  if (!role) {
    throw noSuchRole(roleName)
  }
  return role
}

export function findRole(account: string, roleName: string): Role | undefined {
  return loadIam(account).roles[roleName]
}

export function createRole(account: string, props: {
  roleName: string
  assumeRolePolicyDocument: PolicyDocument
  path?: string
  description?: string
  maxSessionDuration?: number
}): Role {
  const { roleName, assumeRolePolicyDocument } = props
  const path = props.path ?? '/'
  const maxSessionDuration = props.maxSessionDuration ?? 3600
  if (!NAME_PATTERN.test(roleName)) {
    validationError(`1 validation error detected: Value '${roleName}' at 'roleName' failed to satisfy constraint: Member must satisfy regular expression pattern: [\\w+=,.@-]+`)
  }
  if (!/^(\/|\/[\u0021-\u007E]+\/)$/.test(path)) {
    validationError(`1 validation error detected: Value '${path}' at 'path' failed to satisfy constraint: Member must satisfy regular expression pattern: (\\u002F)|(\\u002F[\\u0021-\\u007E]+\\u002F)`)
  }
  if (!Number.isInteger(maxSessionDuration) || maxSessionDuration < 3600 || maxSessionDuration > 43200) {
    validationError(`1 validation error detected: Value '${maxSessionDuration}' at 'maxSessionDuration' failed to satisfy constraint: Member must have value between 3600 and 43200`)
  }
  const state = loadIam(account)
  if (Object.keys(state.roles).some(n => n.toLowerCase() === roleName.toLowerCase())) {
    throw new AwsError('EntityAlreadyExists', `Role with name ${roleName} already exists.`, 409)
  }
  const role: Role = {
    roleName,
    roleId: generateIamId('AROA'),
    path,
    arn: `arn:aws:iam::${account}:role${path}${roleName}`,
    createDate: Date.now(),
    assumeRolePolicyDocument,
    description: props.description,
    maxSessionDuration,
    inlinePolicies: {},
    attachedPolicies: []
  }
  state.roles[roleName] = role
  saveIam(account, state)
  return role
}

export function listRoles(account: string, pathPrefix: string = '/'): Role[] {
  return Object.values(loadIam(account).roles).filter(r => r.path.startsWith(pathPrefix))
}

export function attachmentCounts(account: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const role of Object.values(loadIam(account).roles)) {
    for (const arn of role.attachedPolicies) {
      counts[arn] = (counts[arn] ?? 0) + 1
    }
  }
  return counts
}

export function deleteRole(account: string, roleName: string) {
  const state = loadIam(account)
  const role = state.roles[roleName]
  if (!role) {
    throw noSuchRole(roleName)
  }
  if (role.attachedPolicies.length > 0 || Object.keys(role.inlinePolicies).length > 0) {
    throw new AwsError('DeleteConflict', 'Cannot delete entity, must detach all policies first.', 409)
  }
  delete state.roles[roleName]
  saveIam(account, state)
}

export function putRolePolicy(account: string, roleName: string, policyName: string, document: PolicyDocument) {
  if (!NAME_PATTERN.test(policyName)) {
    validationError(`1 validation error detected: Value '${policyName}' at 'policyName' failed to satisfy constraint: Member must satisfy regular expression pattern: [\\w+=,.@-]+`)
  }
  const state = loadIam(account)
  const role = state.roles[roleName]
  if (!role) {
    throw noSuchRole(roleName)
  }
  role.inlinePolicies[policyName] = document
  saveIam(account, state)
}

export function getRolePolicy(account: string, roleName: string, policyName: string): PolicyDocument {
  const document = getRole(account, roleName).inlinePolicies[policyName]
  if (document === undefined) {
    throw new AwsError('NoSuchEntity', `The role policy with name ${policyName} cannot be found.`, 404)
  }
  return document
}

export function deleteRolePolicy(account: string, roleName: string, policyName: string) {
  const state = loadIam(account)
  const role = state.roles[roleName]
  if (!role) {
    throw noSuchRole(roleName)
  }
  if (!(policyName in role.inlinePolicies)) {
    throw new AwsError('NoSuchEntity', `The role policy with name ${policyName} cannot be found.`, 404)
  }
  delete role.inlinePolicies[policyName]
  saveIam(account, state)
}

export function attachRolePolicy(account: string, roleName: string, policyArn: string) {
  if (!findManagedPolicy(policyArn)) {
    throw new AwsError('NoSuchEntity', `Policy ${policyArn} does not exist or is not attachable.`, 404)
  }
  const state = loadIam(account)
  const role = state.roles[roleName]
  if (!role) {
    throw noSuchRole(roleName)
  }
  if (!role.attachedPolicies.includes(policyArn)) {
    role.attachedPolicies.push(policyArn)
    saveIam(account, state)
  }
}

export function detachRolePolicy(account: string, roleName: string, policyArn: string) {
  const state = loadIam(account)
  const role = state.roles[roleName]
  if (!role) {
    throw noSuchRole(roleName)
  }
  if (!role.attachedPolicies.includes(policyArn)) {
    throw new AwsError('NoSuchEntity', `Policy ${policyArn} was not found.`, 404)
  }
  role.attachedPolicies = role.attachedPolicies.filter(a => a !== policyArn)
  saveIam(account, state)
}

// An assumed-role session is matched by trust policies as the role itself.
function trustPrincipal(callerArn: string): string {
  const m = callerArn.match(/^arn:aws:sts::(\d{12}):assumed-role\/([^/]+)\//)
  return m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : callerArn
}

// Only sts:AssumeRole with Principal.AWS is handled; Condition blocks are not evaluated yet.
export function trustAllows(role: Role, callerArn: string): boolean {
  const caller = trustPrincipal(callerArn)
  const callerAccount = callerArn.split(':')[4]
  const document = role.assumeRolePolicyDocument
  const statements: any[] = [].concat(document.Statement)
  const applicable = statements.filter(s => {
    const actions: string[] = [].concat(s.Action ?? [])
    const principals: string[] = s.Principal === '*' ? ['*'] : [].concat(s.Principal?.AWS ?? [])
    return actions.some(a => a === '*' || a === 'sts:*' || a === 'sts:AssumeRole')
      && principals.some(p => p === '*' || p === caller || p === callerAccount || p === `arn:aws:iam::${callerAccount}:root`)
  })
  return applicable.some(s => s.Effect === 'Allow') && !applicable.some(s => s.Effect === 'Deny')
}

// Whether a service (lambda.amazonaws.com) can assume the role: Principal.Service in the trust policy. Conditions are not
// evaluated yet.
export function trustsService(role: Role, service: string): boolean {
  const statements: any[] = [].concat(role.assumeRolePolicyDocument.Statement as any)
  const applicable = statements.filter(s => {
    const actions: string[] = [].concat(s.Action ?? [])
    const services: string[] = [].concat(s.Principal?.Service ?? [])
    return actions.some(a => a === '*' || a === 'sts:*' || a === 'sts:AssumeRole') && services.includes(service)
  })
  return applicable.some(s => s.Effect === 'Allow') && !applicable.some(s => s.Effect === 'Deny')
}
