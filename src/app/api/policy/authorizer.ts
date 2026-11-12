import { AwsError } from "../common"
import type { AuthorizationRequest } from "../authorization"
import type { PolicyDocument } from "../data/reference"
import { evaluateIdentityPolicies, evaluateResourcePolicy, PolicyNotModelled } from "./engine"
import { subjectOf } from "./identity"
import { accountOf } from "./principal"

// Actions that need no permission, whatever the policies say: AWS documents sts:GetCallerIdentity as an operation for which
// "no permissions are required", and an explicit deny does not stop it either. This is how a function can always ask who
// it is, even when its role has no policy at all.
const NO_PERMISSION_REQUIRED = new Set(['sts:GetCallerIdentity'])

// The resource-based policy of the resource a request is for, and the account that owns the resource. `document` is absent
// when the resource has no policy: for a request from another account that is a denial.
export interface ResourcePolicy {
  account: string
  source: string
  document?: PolicyDocument
}

type Reason = 'identity-deny' | 'resource-deny' | 'no-identity-allow' | 'no-resource-allow'

// The error each kind of service gives. EC2 has its own code; the Query services IAM and STS and the REST service S3 say
// AccessDenied; the JSON and REST services say AccessDeniedException.
function denial(principal: string, action: string, resource: string, why: Reason): AwsError {
  const reason = {
    'identity-deny': 'with an explicit deny in an identity-based policy',
    'resource-deny': 'with an explicit deny in a resource-based policy',
    'no-identity-allow': `because no identity-based policy allows the ${action} action`,
    'no-resource-allow': `because no resource-based policy allows the ${action} action`,
  }[why]
  const message = `User: ${principal} is not authorized to perform: ${action} on resource: ${resource} ${reason}`
  const service = action.split(':')[0]
  if (service === 'ec2') {
    return new AwsError('UnauthorizedOperation', `You are not authorized to perform this operation. ${message}`, 403)
  }
  return new AwsError(['iam', 'sts', 's3'].includes(service) ? 'AccessDenied' : 'AccessDeniedException', message, 403)
}

// Why a principal may not perform an action on a resource, as the error the service would answer with; undefined when it may.
// Used by the authorizer and by the services that act for a role themselves (Lambda writing the log of a function).
//
// The IAM evaluation logic for the policies that are modelled:
// - an explicit deny in an identity-based or in the resource-based policy denies;
// - within the account that owns the resource, an allow in either is enough, but a resource-based allow that names only the
//   account (arn:aws:iam::<account>:root) delegates to the identity-based policies and does not grant on its own;
// - from another account both are needed: the identity-based policies of the caller and the resource-based policy.
// An identity the simulator holds no policies for (see identity.ts) counts as allowed by its identity-based policies.
export function accessDenial(principal: string, action: string, resource: string, resourcePolicy?: ResourcePolicy): AwsError | undefined {
  if (NO_PERMISSION_REQUIRED.has(action)) {
    return undefined
  }
  const subject = subjectOf(principal)
  try {
    const identity = subject.restricted ? evaluateIdentityPolicies(subject.policies, action, resource) : undefined
    if (identity?.decision === 'explicit-deny') {
      return denial(principal, action, resource, 'identity-deny')
    }
    const onResource = resourcePolicy?.document
      ? evaluateResourcePolicy({ source: resourcePolicy.source, document: resourcePolicy.document }, principal, action, resource)
      : undefined
    if (onResource?.decision === 'explicit-deny') {
      return denial(principal, action, resource, 'resource-deny')
    }
    const identityAllows = identity === undefined || identity.decision === 'allow'
    const resourceAllows = onResource?.decision === 'allow'
    if (resourcePolicy && accountOf(principal) !== resourcePolicy.account) {
      if (!identityAllows) {
        return denial(principal, action, resource, 'no-identity-allow')
      }
      return resourceAllows ? undefined : denial(principal, action, resource, 'no-resource-allow')
    }
    if (identityAllows || (resourceAllows && onResource?.decidedBy?.principal !== 'account')) {
      return undefined
    }
    return denial(principal, action, resource, 'no-identity-allow')
  } catch (error) {
    if (error instanceof PolicyNotModelled) {
      return new AwsError('PolicyNotModelled', `The simulator cannot decide whether ${principal} may perform ${action} on ${resource}: ${error.message}`, 501)
    }
    throw error
  }
}

// Every resource the request names must be allowed.
export function policyAuthorizer(request: AuthorizationRequest): void {
  for (const resource of request.resources.length ? request.resources : ['*']) {
    const denied = accessDenial(request.principal, request.action, resource, request.resourcePolicy)
    if (denied) {
      throw denied
    }
  }
}
