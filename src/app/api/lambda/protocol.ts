import { AwsError } from "../common"
import type { ProtocolAdapter } from "../registry"

// REST JSON as Lambda uses it: the operation is the route (one route file per operation), the function is in the path,
// the body is JSON, except for Invoke where the body is the event itself and the answer the function's response.
// Operations that take a query string (Qualifier, Marker, MaxItems) are decoded here too, but note that proxy.ts does not
// yet sign-check query strings, so they work only without one.
const STATUS: Record<string, number> = { CreateFunction: 201, DeleteFunction: 204 }

export class LambdaProtocol implements ProtocolAdapter<any> {
  async decode(request: Request, routeAction?: string) {
    const url = new URL(request.url)
    const name = /\/functions\/([^/]+)/.exec(url.pathname)?.[1]
    const resource = /\/tags\/(.+)$/.exec(url.pathname)?.[1]
    const query = Object.fromEntries(url.searchParams)
    const path = {
      ...(name === undefined ? {} : { FunctionName: decodeURIComponent(name) }),
      ...(resource === undefined ? {} : { Resource: decodeURIComponent(resource) }),
    }
    if (routeAction === 'Invoke') {
      return {
        action: 'Invoke',
        params: {
          ...path,
          Payload: await request.text(),
          InvocationType: request.headers.get('x-amz-invocation-type') ?? undefined,
          LogType: request.headers.get('x-amz-log-type') ?? undefined,
          ClientContext: request.headers.get('x-amz-client-context') ?? undefined,
          Qualifier: query.Qualifier,
        },
      }
    }
    let body: any = {}
    if (request.method === 'POST' || request.method === 'PUT') {
      const text = await request.text()
      try {
        body = text.trim() ? JSON.parse(text) : {}
      } catch {
        throw new AwsError('InvalidRequestContentException', 'Could not parse request body into json: Could not parse payload into json', 400)
      }
    }
    return { action: routeAction ?? '', params: { ...query, ...body, ...path } }
  }

  unknownOperation(action: string) {
    return new AwsError('UnknownOperationException', `Unknown operation ${action}`, 404)
  }

  success(action: string, result: unknown) {
    if (result instanceof Response) {
      return result
    }
    const status = STATUS[action] ?? 200
    return new Response(status === 204 ? null : JSON.stringify(result ?? {}), {
      status,
      headers: status === 204 ? {} : { 'Content-Type': 'application/json' },
    })
  }

  failure(error: unknown) {
    if (!(error instanceof AwsError)) {
      console.error(error)
    }
    const err = error instanceof AwsError ? error : new AwsError('ServiceException', 'Internal error', 500)
    return new Response(JSON.stringify({ Type: err.status >= 500 ? 'Service' : 'User', Message: err.message }), {
      status: err.status,
      headers: { 'Content-Type': 'application/json', 'x-amzn-ErrorType': err.type },
    })
  }
}
