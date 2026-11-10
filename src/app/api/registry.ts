import { authorize } from "./authorization"
import { AwsError, getRequestInfo } from "./common"

export interface RequestContext<P = any> {
  principal: string
  account: string
  region: string
  userId: string
  params: P
}

export type Handler<P = any> = (ctx: RequestContext<P>) => unknown | Promise<unknown>

// Declares what the (future) policy engine needs to know about an operation.
export interface Operation<P = any> {
  handler: Handler<P>
  // IAM action name when it differs from `<iamPrefix>:<operation>`.
  action?: string
  // Resource ARNs the operation touches; '*' when omitted.
  resources?: (ctx: RequestContext<P>) => string[]
}

// Turns a raw HTTP request into (action, params) and results/errors into protocol-shaped responses.
export interface ProtocolAdapter<P = any> {
  decode(request: Request, routeAction?: string): Promise<{ action: string; params: P }>
  unknownOperation(action: string): AwsError
  success(action: string, result: unknown): Response
  failure(error: unknown): Response
}

export interface ServiceDefinition<P> {
  iamPrefix: string
  protocol: ProtocolAdapter<P>
  operations: Record<string, Handler<P> | Operation<P>>
}

type Route = (request: Request) => Promise<Response>
type DynamicRoute = (request: Request, route: { params: Promise<{ action: string }> }) => Promise<Response>

export function defineService<P>(definition: ServiceDefinition<P>) {
  const { iamPrefix, protocol, operations } = definition

  async function dispatch(request: Request, routeAction?: string): Promise<Response> {
    try {
      const { action, params } = await protocol.decode(request, routeAction)
      if (!Object.hasOwn(operations, action)) {
        throw protocol.unknownOperation(action)
      }
      const entry = operations[action]
      const operation: Operation<P> = typeof entry === 'function' ? { handler: entry } : entry
      const info = getRequestInfo(request)
      const ctx: RequestContext<P> = {
        principal: info.user,
        account: info.principalAccount,
        region: info.region,
        userId: info.userId,
        params
      }
      authorize({
        principal: ctx.principal,
        action: operation.action ?? `${iamPrefix}:${action}`,
        resources: operation.resources?.(ctx) ?? ['*'],
        context: ctx
      })
      return protocol.success(action, await operation.handler(ctx))
    } catch (e) {
      return protocol.failure(e)
    }
  }

  return {
    // The protocol decides the action (Action= form field or x-amz-target).
    post: ((request) => dispatch(request)) as Route,
    // One static route file per operation.
    postAction: (action: string): Route => request => dispatch(request, action),
    // A [action] dynamic route segment.
    postDynamic: (async (request, { params }) => dispatch(request, (await params).action)) as DynamicRoute
  }
}
