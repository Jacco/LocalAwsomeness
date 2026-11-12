import * as iam from '../data/iam'
import type { QueryHandler } from "../query"

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const encodeDocument = (document: iam.PolicyDocument) => encodeURIComponent(JSON.stringify(document))

export function roleView(r: iam.Role) {
  return {
    Path: r.path,
    RoleName: r.roleName,
    RoleId: r.roleId,
    Arn: r.arn,
    CreateDate: iso(r.createDate),
    AssumeRolePolicyDocument: encodeDocument(r.assumeRolePolicyDocument),
    Description: r.description,
    MaxSessionDuration: r.maxSessionDuration
  }
}

export const roleHandlers: Record<string, QueryHandler> = {
  CreateRole({ account, params: q }) {
    const maxSessionDuration = q.optional('MaxSessionDuration')
    const role = iam.createRole(account, {
      roleName: q.required('RoleName'),
      assumeRolePolicyDocument: iam.parsePolicyDocument(q.required('AssumeRolePolicyDocument')),
      path: q.optional('Path'),
      description: q.optional('Description'),
      maxSessionDuration: maxSessionDuration === undefined ? undefined : Number(maxSessionDuration)
    })
    return { Role: roleView(role) }
  },
  GetRole({ account, params: q }) {
    return { Role: roleView(iam.getRole(account, q.required('RoleName'))) }
  },
  ListRoles({ account, params: q }) {
    return {
      Roles: { member: iam.listRoles(account, q.optional('PathPrefix')).map(roleView) },
      IsTruncated: false
    }
  },
  DeleteRole({ account, params: q }) {
    iam.deleteRole(account, q.required('RoleName'))
    return undefined
  },
  PutRolePolicy({ account, params: q }) {
    iam.putRolePolicy(account, q.required('RoleName'), q.required('PolicyName'), iam.parsePolicyDocument(q.required('PolicyDocument')))
    return undefined
  },
  GetRolePolicy({ account, params: q }) {
    const roleName = q.required('RoleName')
    const policyName = q.required('PolicyName')
    return {
      RoleName: roleName,
      PolicyName: policyName,
      PolicyDocument: encodeDocument(iam.getRolePolicy(account, roleName, policyName))
    }
  },
  DeleteRolePolicy({ account, params: q }) {
    iam.deleteRolePolicy(account, q.required('RoleName'), q.required('PolicyName'))
    return undefined
  },
  ListRolePolicies({ account, params: q }) {
    const role = iam.getRole(account, q.required('RoleName'))
    return { PolicyNames: { member: Object.keys(role.inlinePolicies) }, IsTruncated: false }
  },
  AttachRolePolicy({ account, params: q }) {
    iam.attachRolePolicy(account, q.required('RoleName'), q.required('PolicyArn'))
    return undefined
  },
  DetachRolePolicy({ account, params: q }) {
    iam.detachRolePolicy(account, q.required('RoleName'), q.required('PolicyArn'))
    return undefined
  },
  // Instance profiles are not implemented (they come with the EC2 instance context), so no role is in one. Terraform asks
  // before it deletes a role.
  ListInstanceProfilesForRole({ account, params: q }) {
    iam.getRole(account, q.required('RoleName'))
    return { InstanceProfiles: { member: [] }, IsTruncated: false }
  },
  ListAttachedRolePolicies({ account, params: q }) {
    const role = iam.getRole(account, q.required('RoleName'))
    return {
      AttachedPolicies: {
        member: role.attachedPolicies.map(arn => ({ PolicyName: arn.split('/').at(-1), PolicyArn: arn }))
      },
      IsTruncated: false
    }
  }
}
