import type { RequestContext } from "./registry"

export interface AuthorizationRequest {
  principal: string
  action: string
  resources: string[]
  context: RequestContext
}

// Throws an AwsError (AccessDenied) to reject the request.
export type Authorizer = (request: AuthorizationRequest) => void

// No policy evaluation exists yet, so everything is allowed. The future policy engine
// plugs in here and should also back a "can X perform Y" query.
let authorizer: Authorizer = () => {}

export function setAuthorizer(next: Authorizer) {
  authorizer = next
}

export function authorize(request: AuthorizationRequest) {
  authorizer(request)
}
