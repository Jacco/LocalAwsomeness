import type { RequestContext } from "./registry"
import { policyAuthorizer, type ResourcePolicy } from "../auth/policy/authorizer"
import { AwsError } from "./common"
import { logCloudTrailEvent, nextSequence, type CloudTrailEvent } from "./cloudtrail/cloudtrail"

export interface AuthorizationRequest {
  principal: string
  action: string
  resources: string[]
  context: RequestContext
  // The resource-based policy of the resource and the account that owns it (an S3 bucket and its bucket policy).
  resourcePolicy?: ResourcePolicy
}

// Throws an AwsError (AccessDenied) to reject the request.
export type Authorizer = (request: AuthorizationRequest) => void

// Identity-based policies of roles and resource-based policies are evaluated (src/app/api/policy/policy.md); identities the
// simulator holds no policies for are not restricted by identity-based policies. The rest of the policy engine plugs in here
// and should also back a "can X perform Y" query.
let authorizer: Authorizer = policyAuthorizer

export function setAuthorizer(next: Authorizer) {
  authorizer = next
}

// The event goes to the trail of the caller's account and, for a request on a resource of another account, also to the
// trail of the owner, as CloudTrail does for cross-account calls.
function logInvolvedAccounts(event: CloudTrailEvent, resourcePolicy?: ResourcePolicy) {
  logCloudTrailEvent(event)
  if (resourcePolicy && resourcePolicy.account !== event.account) {
    logCloudTrailEvent({ ...event, account: resourcePolicy.account })
  }
}

// Records the outcome of an allowed call: the error it failed with, if any.
export type CompleteCall = (error?: unknown) => void

// Authorizes a request. A denial is recorded in CloudTrail and thrown at once. An allowed call is recorded when it
// completes, through the returned function, so the event carries the error the operation failed with (as CloudTrail
// records errorCode and errorMessage for calls that were authorized but failed). The event keeps the time and the
// sequence of the request, so it sorts before the events the operation caused (iam:PassRole, KMS, AssumeRole).
export function authorize(request: AuthorizationRequest): CompleteCall {
  const { principal, action, resources, context, resourcePolicy } = request

  const [service] = action.split(':')
  const event = {
    timestamp: new Date().toISOString(),
    sequence: nextSequence(),
    principal,
    service: service.toLowerCase(),
    action: action.split(':')[1] || action,
    resource: resources[0] || '*',
    resources: resources.length > 1 ? resources.slice(1) : undefined,
    account: context.account,
    region: context.region,
    parameters: context.params as Record<string, unknown>
  }

  try {
    authorizer(request)
  } catch (error) {
    logInvolvedAccounts({
      ...event,
      authorizationDecision: 'deny',
      authorizationReason: (error as any)?.message || String(error),
      errorCode: (error as any)?.type || (error as any)?.code || 'AccessDenied'
    }, resourcePolicy)
    throw error
  }

  return (failure?: unknown) => {
    logInvolvedAccounts({
      ...event,
      authorizationDecision: 'allow',
      ...(failure !== undefined && {
        errorCode: failure instanceof AwsError ? failure.type : 'InternalFailure',
        errorMessage: failure instanceof Error ? failure.message : String(failure)
      })
    }, resourcePolicy)
  }
}
