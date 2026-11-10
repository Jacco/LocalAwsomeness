import { randomBytes } from "crypto";

interface RequestInfo {
  principalAccount: string
  region: string
  user: string
  userId: string
}

export function getRequestInfo(request: Request): RequestInfo {
  const principal = request.headers.get('x-aws-principal')
  const region = request.headers.get('authorization')?.split(' ').at(1)?.split('=').at(-1)?.split('/').at(2)!
  return {
    principalAccount: principal?.split(':').at(4)!,
    region,
    user: principal!,
    userId: request.headers.get('x-aws-userid')!
  }
}

export function ok(obj?: any): Response {
  return new Response(obj ? JSON.stringify(obj, null, 2) : '', {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function okxml(xml?: string): Response {
  return new Response(xml ? xml : '', {
    status: 200,
    headers: { 'Content-Type': 'application/xml' }
  });
}

export class AwsError extends Error {
  constructor(public type: string, message: string, public status: number = 400) {
    super(message)
    this.name = type
  }
}

export function awsJson(obj?: unknown, version: '1.0' | '1.1' = '1.1'): Response {
  return new Response(JSON.stringify(obj ?? {}), {
    status: 200,
    headers: { 'Content-Type': `application/x-amz-json-${version}` }
  })
}

export function awsJsonError(e: unknown, version: '1.0' | '1.1' = '1.1'): Response {
  const err = e instanceof AwsError
    ? e
    : new AwsError('ServiceException', (e as Error)?.message ?? 'Internal error', 500)
  return new Response(JSON.stringify({ __type: err.type, message: err.message }), {
    status: err.status,
    headers: {
      'Content-Type': `application/x-amz-json-${version}`,
      'x-amzn-errortype': err.type
    }
  })
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'

export function generateIamId(prefix: string, len: number = 21): string {
  const bts = randomBytes(len - prefix.length)
  return prefix + bts.reduce((p,c) => p + alphabet[c % alphabet.length], '')
}