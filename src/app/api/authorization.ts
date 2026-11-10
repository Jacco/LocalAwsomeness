import type { RequestContext } from "./registry"
import { identityAuthorizer } from "./policy/authorizer"

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
  authorizer(request)
}
