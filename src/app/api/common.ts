import { randomBytes } from "crypto";

interface RequestInfo {
  principalAccount: string
  region: string
  user: string
}

export function getRequestInfo(request: Request): RequestInfo {
  const principal = request.headers.get('x-aws-principal')
  const region = request.headers.get('authorization')?.split(' ').at(1)?.split('=').at(-1)?.split('/').at(2)!
  return {
    principalAccount: principal?.split(':').at(4)!,
    region,
    user: principal!
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

export function error(e: any): Response {
  return new Response(JSON.stringify({
    code: 'InvalidInputException',
    message: (e as Error).message
  }), { status: 400 })
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'

export function generateIamId(prefix: string, len: number = 21): string {
  const bts = randomBytes(len - prefix.length)
  return prefix + bts.reduce((p,c) => p + alphabet[c % alphabet.length], '')
}