import { findRole } from "../data/iam"
import { findManagedPolicy } from "../data/reference"
import type { IdentityPolicy } from "./engine"

// Who a request is made as, and which identity-based policies apply to it.

export type Subject =
  // Not restricted: the simulator holds no policies for this identity (the bootstrap and test identities, the account root,
  // anything that is not a role in IAM state), so there is nothing to evaluate.
  | { restricted: false; reason: string }
  | { restricted: true; role: string; policies: IdentityPolicy[] }

const ASSUMED_ROLE = /^arn:aws:sts::(\d{12}):assumed-role\/([^/]+)\//
const ROLE = /^arn:aws:iam::(\d{12}):role\/(?:.*\/)?([^/]+)$/

export function subjectOf(principal: string): Subject {
  const match = ASSUMED_ROLE.exec(principal) ?? ROLE.exec(principal)
  if (!match) {
    return { restricted: false, reason: `${principal} is not a role` }
  }
  const [, account, roleName] = match
  const role = findRole(account, roleName)
  if (!role) {
    return { restricted: false, reason: `no role ${roleName} in account ${account}` }
  }
  const policies: IdentityPolicy[] = Object.entries(role.inlinePolicies).map(([name, document]) => ({
    source: `inline policy "${name}" of role ${roleName}`,
    document,
  }))
  for (const arn of role.attachedPolicies) {
    const managed = findManagedPolicy(arn)
    if (managed) {
      policies.push({ source: `managed policy ${managed.name} attached to role ${roleName}`, document: managed.documents[managed.defaultVersion] })
    }
  }
  return { restricted: true, role: role.arn, policies }
}
