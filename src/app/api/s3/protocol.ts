import { randomUUID } from "crypto"
import { AwsError } from "../common"
import type { ProtocolAdapter } from "../registry"

// S3 REST protocol, path-style: /<bucket>/<key>. The proxy rewrites signed requests to /api/s3/<bucket>/<key>.
// The operation is derived from method, path and query subresources; results are rendered as S3 XML,
// raw object bytes, or headers only.

const NS = 'http://s3.amazonaws.com/doc/2006-03-01/'
const ROUTE_PREFIX = '/api/s3'
export const VHOST_BUCKET_HEADER = 'x-jpk-s3-bucket'

// Query parameters that don't select a different operation. Anything else is an unsupported subresource.
const LIST_PARAMS = ['list-type', 'prefix', 'delimiter', 'max-keys', 'continuation-token', 'start-after', 'encoding-type', 'fetch-owner']
const IGNORED_PARAMS = ['x-id', 'region']

const STATUS: Record<string, number> = {
  AccessDenied: 403,
  AuthFailure: 403,
  BucketAlreadyExists: 409,
  BucketAlreadyOwnedByYou: 409,
  BucketNotEmpty: 409,
  MethodNotAllowed: 405,
  NoSuchBucket: 404,
  NoSuchBucketPolicy: 404,
  NoSuchKey: 404,
  NotFound: 404,
  NotImplemented: 501,
  ResourceNotFoundException: 404,
}

export function escapeXml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Renders a plain object as XML elements; arrays repeat the element name (S3's flattened lists).
function toXml(obj: Record<string, unknown>): string {
  let out = ''
  for (const [name, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue
    const items = Array.isArray(value) ? value : [value]
    for (const item of items) {
      out += typeof item === 'object' && !(item instanceof Date)
        ? `<${name}>${toXml(item as Record<string, unknown>)}</${name}>`
        : `<${name}>${escapeXml(item instanceof Date ? item.toISOString() : item)}</${name}>`
    }
  }
  return out
}

function xmlDocument(root: string, body: Record<string, unknown>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${NS}">${toXml(body)}</${root}>`
}

function xmlResponse(root: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(xmlDocument(root, body), {
    status: 200,
    headers: { 'Content-Type': 'application/xml', ...headers },
  })
}

function empty(status: number, headers: Record<string, string | undefined> = {}): Response {
  return new Response(null, { status, headers: definedHeaders(headers) })
}

function definedHeaders(headers: Record<string, string | number | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])
  )
}

export type S3Params = Record<string, unknown>

// What the operations in s3.ts return, as far as rendering a response needs it.
interface S3Result {
  [field: string]: unknown
  Location?: string
  BucketRegion?: string
  Policy?: string
  Body?: Buffer
  ContentType?: string
  ContentLength?: number
  ETag?: string
  LastModified?: string
  VersionId?: string
  ServerSideEncryption?: string
  SSEKMSKeyId?: string
}

function objectHeaders(r: S3Result): Record<string, string> {
  return definedHeaders({
    'Content-Type': r.ContentType,
    'Content-Length': r.ContentLength,
    'ETag': r.ETag,
    'Last-Modified': r.LastModified ? new Date(r.LastModified).toUTCString() : undefined,
    'x-amz-version-id': r.VersionId,
    'x-amz-server-side-encryption': r.ServerSideEncryption,
    'x-amz-server-side-encryption-aws-kms-key-id': r.SSEKMSKeyId,
  })
}

// Keys become directories on disk: refuse segments that would escape or collapse in a path.
function assertSafeKey(key: string) {
  if (key.split('/').some((segment, i, all) => segment === '..' || segment === '.' || (segment === '' && i < all.length - 1))) {
    throw new AwsError('InvalidArgument', `Object key not supported by this simulator: ${key}`)
  }
}

function assertValidBucketName(bucket: string) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) {
    throw new AwsError('InvalidBucketName', 'The specified bucket is not valid.')
  }
}

function unsupported(url: URL, allowed: string[]): string | undefined {
  return [...url.searchParams.keys()].find(name => !allowed.includes(name) && !IGNORED_PARAMS.includes(name))
}

function listParams(url: URL) {
  const q = url.searchParams
  const maxKeys = q.get('max-keys')
  return {
    Prefix: q.get('prefix') ?? '',
    Delimiter: q.get('delimiter') || undefined,
    MaxKeys: maxKeys !== null ? parseInt(maxKeys, 10) : undefined,
    ContinuationToken: q.get('continuation-token') ?? undefined,
    StartAfter: q.get('start-after') ?? undefined,
    EncodingType: q.get('encoding-type') ?? undefined,
  }
}

export class S3Protocol implements ProtocolAdapter<S3Params> {
  async decode(request: Request): Promise<{ action: string; params: S3Params }> {
    const decoded = await this.decodeOperation(request)
    // ExpectedBucketOwner: the request fails with 403 when another account owns the bucket (s3/service.ts).
    const expectedOwner = request.headers.get('x-amz-expected-bucket-owner')
    if (expectedOwner !== null && decoded.params.Bucket !== undefined) {
      decoded.params.ExpectedBucketOwner = expectedOwner
    }
    return decoded
  }

  private async decodeOperation(request: Request): Promise<{ action: string; params: S3Params }> {
    const url = new URL(request.url)
    const method = request.method
    let pathname = url.pathname
    if (pathname === ROUTE_PREFIX || pathname.startsWith(ROUTE_PREFIX + '/')) {
      pathname = pathname.slice(ROUTE_PREFIX.length)
    }
    const rest = pathname.replace(/^\//, '')
    // Virtual-hosted style: the proxy passes the bucket from the Host header; the path is then just the key.
    const hostBucket = request.headers.get(VHOST_BUCKET_HEADER)
    const slash = hostBucket ? -1 : rest.indexOf('/')
    const bucket = hostBucket ?? decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash))
    const key = hostBucket ? decodeURIComponent(rest) : slash === -1 ? '' : decodeURIComponent(rest.slice(slash + 1))

    const notImplemented = (what: string) =>
      new AwsError('NotImplemented', `A header or query you provided implies functionality that is not implemented: ${what}`)

    if (!bucket) {
      if (method !== 'GET') throw new AwsError('MethodNotAllowed', 'The specified method is not allowed against this resource.')
      const sub = unsupported(url, [])
      if (sub) throw notImplemented(sub)
      return { action: 'ListBuckets', params: {} }
    }

    if (!key) {
      if (url.searchParams.has('policy')) {
        const sub = unsupported(url, ['policy'])
        if (sub) throw notImplemented(sub)
        switch (method) {
          case 'GET': return { action: 'GetBucketPolicy', params: { Bucket: bucket } }
          case 'PUT': return { action: 'PutBucketPolicy', params: { Bucket: bucket, Policy: await request.text() } }
          case 'DELETE': return { action: 'DeleteBucketPolicy', params: { Bucket: bucket } }
        }
        throw new AwsError('MethodNotAllowed', 'The specified method is not allowed against this resource.')
      }
      if (method === 'GET') {
        const sub = unsupported(url, LIST_PARAMS)
        if (sub) throw notImplemented(sub)
        if (url.searchParams.get('list-type') !== '2') throw notImplemented('ListObjects (v1); use ListObjectsV2')
        return { action: 'ListObjectsV2', params: { Bucket: bucket, ...listParams(url) } }
      }
      const sub = unsupported(url, [])
      if (sub) throw notImplemented(sub)
      switch (method) {
        case 'HEAD': return { action: 'HeadBucket', params: { Bucket: bucket } }
        case 'PUT':
          assertValidBucketName(bucket)
          return { action: 'CreateBucket', params: { Bucket: bucket } }
        case 'DELETE': return { action: 'DeleteBucket', params: { Bucket: bucket } }
      }
      throw new AwsError('MethodNotAllowed', 'The specified method is not allowed against this resource.')
    }

    assertSafeKey(key)
    const sub = unsupported(url, [])
    if (sub) throw notImplemented(sub)
    const params: S3Params = { Bucket: bucket, Key: key }
    switch (method) {
      case 'GET': return { action: 'GetObject', params }
      case 'HEAD': return { action: 'HeadObject', params }
      case 'DELETE': return { action: 'DeleteObject', params }
      case 'PUT': {
        if (request.headers.has('x-amz-copy-source')) throw notImplemented('CopyObject')
        if (request.headers.get('content-encoding')?.includes('aws-chunked')) throw notImplemented('aws-chunked uploads')
        params.ContentType = request.headers.get('content-type') || 'binary/octet-stream'
        // Not enumerable: keeps the payload out of CloudTrail parameters.
        Object.defineProperty(params, 'Body', { value: Buffer.from(await request.arrayBuffer()), enumerable: false })
        return { action: 'PutObject', params }
      }
    }
    throw new AwsError('MethodNotAllowed', 'The specified method is not allowed against this resource.')
  }

  unknownOperation(action: string): AwsError {
    return new AwsError('NotImplemented', `S3 operation not implemented: ${action}`)
  }

  success(action: string, result: unknown): Response {
    const r = (result ?? {}) as S3Result
    switch (action) {
      case 'ListBuckets':
        return xmlResponse('ListAllMyBucketsResult', {
          Owner: r.Owner,
          Buckets: { Bucket: r.Buckets },
        })
      case 'ListObjectsV2':
        return xmlResponse('ListBucketResult', r)
      case 'CreateBucket':
        return empty(200, { Location: r.Location })
      case 'HeadBucket':
        return empty(200, { 'x-amz-bucket-region': r.BucketRegion })
      case 'GetBucketPolicy':
        return new Response(r.Policy, { status: 200, headers: { 'Content-Type': 'application/json' } })
      case 'PutObject':
        return empty(200, definedHeaders({
          'ETag': r.ETag,
          'x-amz-version-id': r.VersionId,
          'x-amz-server-side-encryption': r.ServerSideEncryption,
          'x-amz-server-side-encryption-aws-kms-key-id': r.SSEKMSKeyId,
        }))
      case 'GetObject':
        return new Response(new Uint8Array(r.Body ?? Buffer.alloc(0)), { status: 200, headers: objectHeaders(r) })
      case 'HeadObject':
        return empty(200, objectHeaders(r))
      case 'DeleteObject':
        return empty(204, { 'x-amz-delete-marker': 'true', 'x-amz-version-id': r.VersionId })
      case 'DeleteBucket':
      case 'PutBucketPolicy':
      case 'DeleteBucketPolicy':
        return empty(204)
    }
    return empty(200)
  }

  failure(error: unknown): Response {
    if (!(error instanceof AwsError)) {
      console.error(error)
    }
    const err = error instanceof AwsError ? error : new AwsError('InternalError', 'We encountered an internal error. Please try again.', 500)
    // The policy engine speaks the JSON services' dialect; S3 calls the same refusal AccessDenied.
    const code = err.type === 'AccessDeniedException' ? 'AccessDenied' : err.type
    const status = err.status !== 400 ? err.status : (STATUS[code] ?? 400)
    const requestId = randomUUID()
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Error>${toXml({ Code: code, Message: err.message, RequestId: requestId })}</Error>`
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'application/xml', 'x-amz-request-id': requestId },
    })
  }
}
