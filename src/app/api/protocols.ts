import { awsJson, awsJsonError, AwsError, ok } from "./common"
import type { ProtocolAdapter } from "./registry"
import { QueryParams, queryError, queryResponse } from "./query"

// Form body with Action=, XML responses (iam, sts).
export class QueryProtocol implements ProtocolAdapter<QueryParams> {
  constructor(private namespace: string, private apiVersion: string) {}

  async decode(request: Request) {
    const params = new QueryParams(await request.text())
    return { action: params.action ?? '', params }
  }

  unknownOperation(action: string) {
    return new AwsError('InvalidAction', `Could not find operation ${action} for version ${this.apiVersion}`)
  }

  success(action: string, result: unknown) {
    return queryResponse(this.namespace, action, result as Record<string, unknown> | undefined)
  }

  failure(error: unknown) {
    return queryError(this.namespace, error)
  }
}

// JSON body, action from x-amz-target or the route (organizations, ssm).
export class JsonProtocol implements ProtocolAdapter<any> {
  constructor(private version: '1.0' | '1.1' = '1.1', private invalidBodyType = 'SerializationException') {}

  async decode(request: Request, routeAction?: string) {
    const action = routeAction ?? request.headers.get('x-amz-target')?.split('.').at(-1) ?? ''
    return { action, params: await parseJsonBody(request, this.invalidBodyType) }
  }

  unknownOperation(action: string) {
    return new AwsError('UnknownOperationException', `Unknown operation ${action}`)
  }

  success(_action: string, result: unknown) {
    return awsJson(result, this.version)
  }

  failure(error: unknown) {
    const err = error instanceof AwsError
      ? error
      : new AwsError('ServiceException', (error as Error)?.message ?? 'Internal error', 500)
    // Log any non-AwsError exceptions
    if (!(error instanceof AwsError) && error instanceof Error) {
      console.error('[JsonProtocol] Non-AwsError exception:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      })
    }
    return new Response(JSON.stringify({ __type: err.type, message: err.message }), {
      status: err.status,
      headers: {
        'Content-Type': `application/x-amz-json-${this.version}`,
        'x-amzn-errortype': err.type
      }
    })
  }
}

// One path per operation, plain JSON in and out (account).
export class RestJsonProtocol implements ProtocolAdapter<any> {
  async decode(request: Request, routeAction?: string) {
    return { action: routeAction ?? '', params: await parseJsonBody(request, 'ValidationException') }
  }

  unknownOperation(action: string) {
    return new AwsError('UnknownOperationException', `Unknown operation ${action}`, 404)
  }

  success(_action: string, result: unknown) {
    return ok(result)
  }

  failure(error: unknown) {
    if (!(error instanceof AwsError)) {
      console.error(error)
    }
    const err = error instanceof AwsError ? error : new AwsError('InternalServerException', 'Internal error', 500)
    return new Response(JSON.stringify({ message: err.message }), {
      status: err.status,
      headers: { 'Content-Type': 'application/json', 'x-amzn-errortype': err.type }
    })
  }
}

async function parseJsonBody(request: Request, errorType: string): Promise<any> {
  const text = await request.text()
  if (!text.trim()) {
    return {}
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new AwsError(errorType, 'The request body is not valid JSON.')
  }
}
