import { QueryProtocol } from "../protocols"
import { IAM_NS } from "../query"
import { defineService } from "../registry"
import { policyHandlers } from "./policies"
import { roleHandlers } from "./roles"
import { userHandlers } from "./users"

/**
 * MODULAR OPERATION ORGANIZATION PATTERN (IAM)
 * 
 * IAM operations are organized by domain into separate handler modules:
 * 
 * - roleHandlers (roles.ts): CreateRole, DeleteRole, GetRole, ListRoles, 
 *   UpdateAssumeRolePolicy, AssumeRole
 * 
 * - policyHandlers (policies.ts): CreatePolicy, DeletePolicy, GetPolicy, 
 *   ListPolicies, AttachUserPolicy, AttachRolePolicy, DetachUserPolicy, 
 *   DetachRolePolicy, GetUserPolicy, GetRolePolicy, ListUserPolicies, 
 *   ListRolePolicies, PutUserPolicy, PutRolePolicy, DeleteUserPolicy, 
 *   DeleteRolePolicy
 * 
 * - userHandlers (users.ts): CreateUser, DeleteUser, GetUser, ListUsers, 
 *   UpdateUser, CreateAccessKey, DeleteAccessKey, ListAccessKeys
 * 
 * The spread operator (...) combines all operations into a single registry.
 * This pattern improves discoverability and maintainability by grouping
 * related operations together.
 */
// TODO Version Prefix MaxItem and also Marker
export const iam = defineService({
  iamPrefix: 'iam',
  protocol: new QueryProtocol(IAM_NS, '2010-05-08'),
  operations: { 
    ...roleHandlers,    // From roles.ts: 6 operations
    ...policyHandlers,  // From policies.ts: 16 operations
    ...userHandlers,    // From users.ts: 8 operations
  }
})
