import { AwsError } from "../common"
import type { AuthorizationRequest } from "../authorization"
import { evaluateIdentityPolicies, PolicyNotModelled, type Evaluation } from "./engine"
import { subjectOf } from "./identity"

// Actions that need no permission, whatever the policies say: AWS documents sts:GetCallerIdentity as an operation for which
// "no permissions are required", and an explicit deny does not stop it either. This is how a function can always ask who
// it is, even when its role has no policy at all.
const NO_PERMISSION_REQUIRED = new Set(['sts:GetCallerIdentity'])

// The error each kind of service gives. EC2 has its own code; the Query services IAM and STS say AccessDenied; the JSON
// and REST services say AccessDeniedException.
function denial(principal: string, evaluation: Evaluation): AwsError {
  const { action, resource } = evaluation
  const reason = evaluation.decision === 'explicit-deny'
    ? 'with an explicit deny in an identity-based policy'
    : `because no identity-based policy allows the ${action} action`
  const message = `User: ${principal} is not authorized to perform: ${action} on resource: ${resource} ${reason}`
  const service = action.split(':')[0]
  if (service === 'ec2') {
    return new AwsError('UnauthorizedOperation', `You are not authorized to perform this operation. ${message}`, 403)
  }
  return new AwsError(service === 'iam' || service === 'sts' ? 'AccessDenied' : 'AccessDeniedException', message, 403)
}

// Every resource the request names must be allowed.
export function identityAuthorizer(request: AuthorizationRequest): void {
  if (NO_PERMISSION_REQUIRED.has(request.action)) {
    return
  }
  const subject = subjectOf(request.principal)
  if (!subject.restricted) {
    return
  }
  for (const resource of request.resources.length ? request.resources : ['*']) {
    let evaluation: Evaluation
    try {
      evaluation = evaluateIdentityPolicies(subject.policies, request.action, resource)
    } catch (error) {
      if (error instanceof PolicyNotModelled) {
        throw new AwsError('PolicyNotModelled', `The simulator cannot decide whether ${request.principal} may perform ${request.action} on ${resource}: ${error.message}`, 501)
      }
      throw error
    }
    if (evaluation.decision !== 'allow') {
      throw denial(request.principal, evaluation)
    }
  }
}
