import type { RequestContext } from "./registry"
import { identityAuthorizer } from "./policy/authorizer"
import { logCloudTrailEvent } from "./cloudtrail/cloudtrail"

export interface AuthorizationRequest {
  principal: string
  action: string
  resources: string[]
  context: RequestContext
}

// Throws an AwsError (AccessDenied) to reject the request.
export type Authorizer = (request: AuthorizationRequest) => void

// Identity-based policies of roles are evaluated (src/app/api/policy/policy.md); identities the simulator holds no policies
// for are not restricted. The rest of the policy engine plugs in here and should also back a "can X perform Y" query.
let authorizer: Authorizer = identityAuthorizer

export function setAuthorizer(next: Authorizer) {
  authorizer = next
}

export function authorize(request: AuthorizationRequest) {
  const { principal, action, resources, context } = request
  
  // Extract service name from action (e.g., "iam:PutRolePolicy" -> "iam")
  const [service] = action.split(':')
  const primaryResource = resources[0] || '*'
  
  try {
    authorizer(request)
    
    // Authorization succeeded - log to CloudTrail
    logCloudTrailEvent({
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
    })
  } catch (error) {
    // Authorization failed - log denial to CloudTrail
    const reason = (error as any)?.message || String(error)
    logCloudTrailEvent({
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
    })
    
    // Re-throw the original error
    throw error
  }
}
