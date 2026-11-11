import type { RequestContext } from "./registry"
import { policyAuthorizer, type ResourcePolicy } from "./policy/authorizer"
import { logCloudTrailEvent, type CloudTrailEvent } from "./cloudtrail/cloudtrail"

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

export function authorize(request: AuthorizationRequest) {
  const { principal, action, resources, context, resourcePolicy } = request
  
  // Extract service name from action (e.g., "iam:PutRolePolicy" -> "iam")
  const [service] = action.split(':')
  const primaryResource = resources[0] || '*'
  
  try {
    authorizer(request)
    
    // Authorization succeeded - log to CloudTrail
    logInvolvedAccounts({
      timestamp: new Date().toISOString(),
      principal,
      service: service.toLowerCase(),
      action: action.split(':')[1] || action,
      resource: primaryResource,
      resources: resources.length > 1 ? resources.slice(1) : undefined,
      authorizationDecision: 'allow',
      account: context.account,
      region: context.region,
      parameters: context.params as Record<string, unknown>
    }, resourcePolicy)
  } catch (error) {
    // Authorization failed - log denial to CloudTrail
    const reason = (error as any)?.message || String(error)
    logInvolvedAccounts({
      timestamp: new Date().toISOString(),
      principal,
      service: service.toLowerCase(),
      action: action.split(':')[1] || action,
      resource: primaryResource,
      resources: resources.length > 1 ? resources.slice(1) : undefined,
      authorizationDecision: 'deny',
      authorizationReason: reason,
      account: context.account,
      region: context.region,
      parameters: context.params as Record<string, unknown>,
      errorCode: (error as any)?.code || 'AccessDenied'
    }, resourcePolicy)
    
    // Re-throw the original error
    throw error
  }
}
