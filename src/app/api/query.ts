import { randomUUID } from 'crypto'
import { Builder } from 'xml2js'
import { AwsError } from './common'

export const IAM_NS = 'https://iam.amazonaws.com/doc/2010-05-08/'
export const STS_NS = 'https://sts.amazonaws.com/doc/2011-06-15/'

export class QueryParams {
  private params: URLSearchParams

  constructor(body: string) {
    this.params = new URLSearchParams(body)
  }

  get action(): string | null {
    return this.params.get('Action')
  }

  optional(name: string): string | undefined {
    return this.params.get(name) ?? undefined
  }

  required(name: string): string {
    const value = this.params.get(name)
    if (!value) {
      throw new AwsError('MissingParameter', `The request must contain the parameter ${name}`)
    }
    return value
  }
}

export interface QueryContext {
  account: string
  principal: string
  userId: string
  q: QueryParams
}

export type QueryHandler = (ctx: QueryContext) => Record<string, unknown> | undefined

const builder = new Builder({ headless: true })

export function queryResponse(ns: string, action: string, result?: Record<string, unknown>): Response {
  const body: Record<string, unknown> = { $: { xmlns: ns } }
  if (result) {
    body[`${action}Result`] = JSON.parse(JSON.stringify(result))
  }
  body.ResponseMetadata = { RequestId: randomUUID() }
  return new Response(builder.buildObject({ [`${action}Response`]: body }), {
    status: 200,
    headers: { 'Content-Type': 'text/xml' }
  })
}

export function queryError(ns: string, e: unknown): Response {
  if (!(e instanceof AwsError)) {
    console.error(e)
  }
  const err = e instanceof AwsError
    ? e
    : new AwsError('InternalFailure', 'The request processing has failed because of an unknown error, exception or failure.', 500)
  const xml = builder.buildObject({
    ErrorResponse: {
      $: { xmlns: ns },
      Error: { Type: err.status >= 500 ? 'Receiver' : 'Sender', Code: err.type, Message: err.message },
      RequestId: randomUUID()
    }
  })
  return new Response(xml, { status: err.status, headers: { 'Content-Type': 'text/xml' } })
}
