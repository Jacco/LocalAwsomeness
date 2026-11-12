import { NextResponse } from 'next/server'
import type { NextFetchEvent, NextRequest } from 'next/server'
import { SignatureV4 } from '@smithy/signature-v4'
import { Sha256 } from '@aws-crypto/sha256-js'
import { randomUUID } from 'crypto'
import { findCredential } from './app/api/data/credentials'
import { VHOST_BUCKET_HEADER } from './app/api/s3/protocol'

function authError(req: NextRequest, service: string, code: string, message: string): Response {
  if (service === 's3') {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message><RequestId>${randomUUID()}</RequestId></Error>`
    return new Response(xml, { status: 403, headers: { 'Content-Type': 'application/xml' } })
  }
  if (service === 'ec2') {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Errors><Error><Code>${code}</Code><Message>${message}</Message></Error></Errors><RequestID>${randomUUID()}</RequestID></Response>`
    return new Response(xml, { status: 403, headers: { 'Content-Type': 'text/xml;charset=UTF-8' } })
  }
  if (req.headers.get('content-type')?.includes('json')) {
    return new Response(JSON.stringify({ __type: code, message }), {
      status: 403,
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'x-amzn-errortype': code }
    })
  }
  const xml = `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error><RequestId>${randomUUID()}</RequestId></ErrorResponse>`
  return new Response(xml, { status: 403, headers: { 'Content-Type': 'text/xml' } })
}

// The query string as the signer wants it: a repeated name has all its values.
function queryOf(params: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {}
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name)
    query[name] = values.length === 1 ? values[0] : values
  }
  return query
}

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  const requestHeaders = new Headers(req.headers)
  requestHeaders.delete('x-aws-principal')
  requestHeaders.delete('x-aws-userid')
  requestHeaders.delete(VHOST_BUCKET_HEADER)
  const keyid = req.headers.get('authorization')?.split(' ').at(1)?.split('=').at(-1)?.split('/').at(0)
  const service = req.headers.get('authorization')?.split(' ').at(1)?.split('=').at(-1)?.split('/').at(3)!
  const region = req.headers.get('authorization')?.split(' ').at(1)?.split('=').at(-1)?.split('/').at(2)!
  if (!service) {
    return NextResponse.next({ request: { headers: requestHeaders } })
  }
  const credential = findCredential(keyid!)
  if (!credential) {
    return authError(req, service, 'InvalidClientTokenId', 'The security token included in the request is invalid.')
  }
  if (credential.sessionToken) {
    if (req.headers.get('x-amz-security-token') !== credential.sessionToken) {
      return authError(req, service, 'InvalidClientTokenId', 'The security token included in the request is invalid.')
    }
    if (credential.expiration !== undefined && credential.expiration < Date.now()) {
      return authError(req, service, 'ExpiredToken', 'The security token included in the request is expired')
    }
  }
  requestHeaders.set('x-aws-principal', credential.principal)
  requestHeaders.set('x-aws-userid', credential.userId)
  const signer = new SignatureV4({
    credentials: {
      accessKeyId: keyid!,
      secretAccessKey: credential.secret,
    },
    service: service,
    region: region,
    sha256: Sha256,
    applyChecksum: false, // TODO if the header is there x-amz-content-sha256
    // S3 signs the path as sent; every other service URI-encodes it once more.
    uriEscapePath: service !== 's3',
  })
  // Re-sign exactly the headers the client signed (SignedHeaders=a;b;c).
  const signedHeaders = req.headers.get('authorization')?.match(/SignedHeaders=([^,\s]+)/)?.[1]?.split(';') ?? []
  const toencode: [string, string][] = []
  for (const header of req.headers) {
    if (signedHeaders.includes(header[0].toLowerCase())) {
      toencode.push(header)
    }
  }
  const dt = req.headers.get('x-amz-date')!
  const dts = dt.substring(0, 4)+'-'+dt.substring(4, 6)+'-'+dt.substring(6,8)+'T'+dt.substring(9, 11)+':'+dt.substring(11, 13)+':'+dt.substring(13, 15)+'Z'
  const sig = await signer.sign({
    headers: Object.fromEntries(toencode),
    hostname: req.nextUrl.hostname,
    query: queryOf(req.nextUrl.searchParams),
    body: await req.text(),
    path: req.nextUrl.pathname,
    method: req.method,
    protocol: req.nextUrl.protocol,
  }, {
    signingDate: new Date(Date.parse(dts)),
  })

  const calculated_sig = sig.headers['authorization'].split(' ').at(-1)?.split('=').at(-1)
  const actual_sig = req.headers.get('authorization')?.split(' ').at(-1)?.split('=').at(-1)
  if (calculated_sig != actual_sig) {
    return authError(req, service, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.')
  }

  const target = req.headers.get('x-amz-target')?.replace('.', '/')
  if (target) {
    const destination = req.url + 'api/' + service + '/' + target
    const newurl = new URL(destination, req.url)
    return NextResponse.rewrite(newurl, {
        request: {
          headers: requestHeaders
        }
    })
  }
  if (service) {
    // S3 virtual-hosted style (<bucket>.localhost:3000/<key>) becomes path style (/<bucket>/<key>).
    const bucket = service === 's3' ? req.headers.get('host')?.match(/^(.+)\.localhost(:\d+)?$/)?.[1] : undefined
    if (bucket) {
      requestHeaders.set(VHOST_BUCKET_HEADER, bucket)
    }
    const path = bucket ? '/' + encodeURIComponent(bucket) + (req.nextUrl.pathname === '/' ? '' : req.nextUrl.pathname) : req.nextUrl.pathname
    const destination = req.nextUrl.protocol + req.nextUrl.host + '/api/' + service + path + req.nextUrl.search
    const newurl = new URL(destination)
    return NextResponse.rewrite(newurl, {
        request: {
          headers: requestHeaders
        }
    })  
  }

  return NextResponse.next({
    request: {
      headers: requestHeaders
    }
  })
}