import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'

// S3 data, KMS keys, IAM state and CloudTrail all follow JPK_DB_ROOT: keep the tests out of data/ and db/.
const root = mkdtempSync(join(tmpdir(), 'jpk-s3-'))
process.env.JPK_DB_ROOT = root

/* eslint-disable @typescript-eslint/no-require-imports */
const { S3Protocol, VHOST_BUCKET_HEADER } = require('@/app/api/s3/protocol')
const ops = require('@/app/api/s3/s3')
const { s3Storage } = require('@/app/api/s3/storage')
const { s3 } = require('@/app/api/s3/service')
const { AwsError } = require('@/app/api/common')
const { createKey } = require('@/app/api/kms/storage')
const { readCloudTrailEvents } = require('@/app/api/cloudtrail/cloudtrail')
const iam = require('@/app/api/db/iam')

const account = '111111111111'
const otherAccount = '222222222222'
const region = 'eu-west-1'
const ADMIN = `arn:aws:sts::${account}:assumed-role/admin/session`

beforeAll(() => {
  mkdirSync(join(root, account), { recursive: true })
  mkdirSync(join(root, otherAccount), { recursive: true })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

interface Named { Name: string; CreationDate: string }
interface Keyed { Key: string }
interface Listing { Contents: Keyed[]; CommonPrefixes: { Prefix: string }[] }

let counter = 0
const uniqueBucket = () => `bucket-${++counter}-${Date.now()}`

// Calls an operation the way the service does; `as` overrides account or principal.
function op(name: string, params: Record<string, unknown>, as: { account?: string; principal?: string } = {}) {
  return ops[name]({ params, account: as.account ?? account, region, principal: as.principal ?? ADMIN })
}

function bucketWith(objects: Record<string, string> = {}) {
  const bucket = uniqueBucket()
  op('createBucketOp', { Bucket: bucket })
  for (const [key, body] of Object.entries(objects)) {
    op('putObjectOp', { Bucket: bucket, Key: key, Body: Buffer.from(body), ContentType: 'text/plain' })
  }
  return bucket
}

const errorOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    const err = e as InstanceType<typeof AwsError>
    return { type: err.type, status: err.status, message: err.message }
  }
  throw new Error('expected an error')
}

describe('S3 protocol', () => {
  const protocol = new S3Protocol()
  const decode = (url: string, init?: RequestInit) => protocol.decode(new Request(`http://localhost:3000${url}`, init))

  describe('decode (path style)', () => {
    it.each([
      ['GET', '/', 'ListBuckets', {}],
      ['GET', '/?region=eu-central-1', 'ListBuckets', {}],
      ['PUT', '/my-bucket', 'CreateBucket', { Bucket: 'my-bucket' }],
      ['DELETE', '/my-bucket', 'DeleteBucket', { Bucket: 'my-bucket' }],
      ['HEAD', '/my-bucket', 'HeadBucket', { Bucket: 'my-bucket' }],
      ['GET', '/my-bucket?policy', 'GetBucketPolicy', { Bucket: 'my-bucket' }],
      ['DELETE', '/my-bucket?policy', 'DeleteBucketPolicy', { Bucket: 'my-bucket' }],
      ['GET', '/my-bucket/path/to/key', 'GetObject', { Bucket: 'my-bucket', Key: 'path/to/key' }],
      ['HEAD', '/my-bucket/path/to/key', 'HeadObject', { Bucket: 'my-bucket', Key: 'path/to/key' }],
      ['DELETE', '/my-bucket/path/to/key', 'DeleteObject', { Bucket: 'my-bucket', Key: 'path/to/key' }],
      ['GET', '/my-bucket/file%20with%20spaces%2B.txt?x-id=GetObject', 'GetObject', { Bucket: 'my-bucket', Key: 'file with spaces+.txt' }],
      ['GET', '/my-bucket?list-type=2&region=eu-central-1', 'ListObjectsV2', { Bucket: 'my-bucket', Prefix: '', MaxKeys: undefined }],
    ])('%s %s is %s', async (method, url, action, params) => {
      const result = await decode(url, { method })
      expect(result.action).toBe(action)
      expect(result.params).toMatchObject(params)
    })

    it('reads the policy document of PutBucketPolicy', async () => {
      const policy = JSON.stringify({ Version: '2012-10-17', Statement: [] })
      const result = await decode('/my-bucket?policy', { method: 'PUT', body: policy })
      expect(result).toMatchObject({ action: 'PutBucketPolicy', params: { Bucket: 'my-bucket', Policy: policy } })
    })

    it('reads the body and content type of PutObject, keeping the body out of the logged parameters', async () => {
      const result = await decode('/my-bucket/a/b.bin', { method: 'PUT', body: new Uint8Array([0, 1, 255]), headers: { 'content-type': 'application/x-thing' } })
      expect(result.action).toBe('PutObject')
      expect(result.params.Body).toEqual(Buffer.from([0, 1, 255]))
      expect(result.params.ContentType).toBe('application/x-thing')
      expect(JSON.parse(JSON.stringify(result.params))).toEqual({ Bucket: 'my-bucket', Key: 'a/b.bin', ContentType: 'application/x-thing' })
    })

    it('defaults the content type of PutObject like S3 does', async () => {
      const result = await decode('/my-bucket/k', { method: 'PUT', body: new Uint8Array([1]) })
      expect(result.params.ContentType).toBe('binary/octet-stream')
    })

    it('reads the ListObjectsV2 parameters', async () => {
      const result = await decode('/my-bucket?list-type=2&prefix=logs%2F&delimiter=%2F&max-keys=10&continuation-token=abc&start-after=x&encoding-type=url&fetch-owner=true')
      expect(result).toEqual({
        action: 'ListObjectsV2',
        params: { Bucket: 'my-bucket', Prefix: 'logs/', Delimiter: '/', MaxKeys: 10, ContinuationToken: 'abc', StartAfter: 'x', EncodingType: 'url' },
      })
    })

    it('strips the /api/s3 route prefix', async () => {
      expect((await decode('/api/s3/my-bucket/k')).params).toMatchObject({ Bucket: 'my-bucket', Key: 'k' })
      expect((await decode('/api/s3')).action).toBe('ListBuckets')
    })
  })

  describe('decode (virtual-hosted style)', () => {
    const vhost = (url: string, init: RequestInit = {}) => decode(url, { ...init, headers: { [VHOST_BUCKET_HEADER]: 'my-bucket' } })

    it('takes the bucket from the proxy header and the whole path as key', async () => {
      expect(await vhost('/a%20b/c.txt')).toMatchObject({ action: 'GetObject', params: { Bucket: 'my-bucket', Key: 'a b/c.txt' } })
    })

    it('treats the root path as the bucket', async () => {
      expect((await vhost('/', { method: 'PUT' })).action).toBe('CreateBucket')
      expect((await vhost('/?list-type=2')).action).toBe('ListObjectsV2')
      expect((await vhost('/?policy', { method: 'DELETE' })).action).toBe('DeleteBucketPolicy')
    })
  })

  describe('decode rejects what is not implemented instead of guessing', () => {
    it.each([
      ['PUT', '/my-bucket?versioning'],
      ['GET', '/my-bucket?acl'],
      ['GET', '/my-bucket?list-type=2&foo=bar'],
      ['GET', '/my-bucket'],
      ['GET', '/my-bucket/key?tagging'],
      ['POST', '/my-bucket/key?uploads'],
      ['GET', '/?foo'],
    ])('%s %s', async (method, url) => {
      await expect(decode(url, { method })).rejects.toMatchObject({ type: 'NotImplemented' })
    })

    it('CopyObject and aws-chunked uploads', async () => {
      await expect(decode('/b/k', { method: 'PUT', body: 'x', headers: { 'x-amz-copy-source': '/a/b' } })).rejects.toMatchObject({ type: 'NotImplemented' })
      await expect(decode('/b/k', { method: 'PUT', body: 'x', headers: { 'content-encoding': 'aws-chunked' } })).rejects.toMatchObject({ type: 'NotImplemented' })
    })

    it.each([['POST', '/'], ['POST', '/my-bucket'], ['POST', '/my-bucket/key'], ['PUT', '/my-bucket?policy&x']])('%s %s', async (method, url) => {
      await expect(decode(url, { method, body: method === 'GET' ? undefined : '' })).rejects.toBeInstanceOf(AwsError)
    })
  })

  describe('decode validates names', () => {
    it.each(['ab', 'Upper', 'under_score', '-start', 'end-', 'a..b', 'x'.repeat(64)])('rejects bucket name %s', async bucket => {
      await expect(decode(`/${bucket}`, { method: 'PUT' })).rejects.toMatchObject({ type: 'InvalidBucketName' })
    })

    it('accepts a valid bucket name', async () => {
      expect((await decode('/my.bucket-1', { method: 'PUT' })).action).toBe('CreateBucket')
    })

    it.each(['a%2F..%2F..%2Fx', '..%2Fx', 'a%2F.%2Fb', 'a%2F%2Fb'])('rejects key %s that does not map to a directory in the bucket', async key => {
      await expect(decode(`/my-bucket/${key}`, { method: 'PUT', body: 'x' })).rejects.toMatchObject({ type: 'InvalidArgument' })
    })
  })

  describe('success', () => {
    it('renders ListBuckets as XML', async () => {
      const response = protocol.success('ListBuckets', { Owner: { ID: 'o', DisplayName: 'd' }, Buckets: [{ Name: 'a', CreationDate: '2024-01-01T00:00:00.000Z' }, { Name: 'b' }] })
      expect(response.headers.get('content-type')).toBe('application/xml')
      expect(await response.text()).toContain('<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>o</ID><DisplayName>d</DisplayName></Owner><Buckets><Bucket><Name>a</Name><CreationDate>2024-01-01T00:00:00.000Z</CreationDate></Bucket><Bucket><Name>b</Name></Bucket></Buckets></ListAllMyBucketsResult>')
    })

    it('renders ListObjectsV2 as XML with escaping and repeated elements', async () => {
      const response = protocol.success('ListObjectsV2', { Name: 'b', Prefix: '', KeyCount: 2, IsTruncated: false, Contents: [{ Key: 'a&<b>', Size: 1 }, { Key: 'c', Size: 2 }], CommonPrefixes: [{ Prefix: 'p/' }], Delimiter: undefined })
      const xml = await response.text()
      expect(xml).toContain('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><Prefix></Prefix><KeyCount>2</KeyCount><IsTruncated>false</IsTruncated>')
      expect(xml).toContain('<Contents><Key>a&amp;&lt;b&gt;</Key><Size>1</Size></Contents><Contents><Key>c</Key><Size>2</Size></Contents><CommonPrefixes><Prefix>p/</Prefix></CommonPrefixes>')
      expect(xml).not.toContain('Delimiter')
    })

    it('returns GetObject as raw bytes with the object headers', async () => {
      const response = protocol.success('GetObject', {
        Body: Buffer.from([0, 255]), ContentType: 'x/y', ContentLength: 2, ETag: '"e"', LastModified: '2024-01-02T03:04:05.000Z',
        VersionId: 'v1', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'k',
      })
      expect(response.status).toBe(200)
      expect(Object.fromEntries(response.headers)).toMatchObject({
        'content-type': 'x/y', 'content-length': '2', etag: '"e"', 'last-modified': 'Tue, 02 Jan 2024 03:04:05 GMT',
        'x-amz-version-id': 'v1', 'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': 'k',
      })
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0, 255]))
    })

    it('returns HeadObject, PutObject and CreateBucket as headers only', async () => {
      const head = protocol.success('HeadObject', { ContentLength: 5, ETag: '"e"' })
      expect([head.status, head.headers.get('content-length'), await head.text()]).toEqual([200, '5', ''])
      const put = protocol.success('PutObject', { ETag: '"e"', VersionId: 'v2' })
      expect([put.headers.get('etag'), put.headers.get('x-amz-version-id'), put.headers.has('x-amz-server-side-encryption')]).toEqual(['"e"', 'v2', false])
      const create = protocol.success('CreateBucket', { Location: '/bucket' })
      expect([create.status, create.headers.get('location')]).toEqual([200, '/bucket'])
      expect(protocol.success('HeadBucket', { BucketRegion: region }).headers.get('x-amz-bucket-region')).toBe(region)
    })

    it('returns 204 for deletes and policy writes', () => {
      for (const action of ['DeleteObject', 'DeleteBucket', 'PutBucketPolicy', 'DeleteBucketPolicy']) {
        expect(protocol.success(action, {}).status).toBe(204)
      }
    })

    it('returns the policy document itself for GetBucketPolicy', async () => {
      expect(await protocol.success('GetBucketPolicy', { Policy: '{"a":1}' }).text()).toBe('{"a":1}')
    })
  })

  describe('failure', () => {
    it.each([
      ['NoSuchBucket', 404], ['NoSuchKey', 404], ['NoSuchBucketPolicy', 404], ['NotFound', 404],
      ['BucketAlreadyOwnedByYou', 409], ['BucketNotEmpty', 409], ['MethodNotAllowed', 405], ['NotImplemented', 501],
      ['InvalidBucketName', 400], ['AuthFailure', 403],
    ])('maps %s to %i', async (code, status) => {
      const response = protocol.failure(new AwsError(code, 'msg <&>'))
      expect(response.status).toBe(status)
      expect(response.headers.get('content-type')).toBe('application/xml')
      const xml = await response.text()
      expect(xml).toMatch(new RegExp(`^<\\?xml version="1.0" encoding="UTF-8"\\?>\\n<Error><Code>${code}</Code><Message>msg &lt;&amp;&gt;</Message><RequestId>[0-9a-f-]{36}</RequestId></Error>$`))
      expect(xml).toContain(response.headers.get('x-amz-request-id'))
    })

    it('keeps an explicit status', () => {
      expect(protocol.failure(new AwsError('AccessDenied', 'no', 403)).status).toBe(403)
    })

    it('reports a policy denial with the S3 code AccessDenied', async () => {
      const response = protocol.failure(new AwsError('AccessDeniedException', 'no', 400))
      expect(response.status).toBe(403)
      expect(await response.text()).toContain('<Code>AccessDenied</Code>')
    })

    it('hides unexpected errors as InternalError 500', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
      const response = protocol.failure(new Error('secret detail'))
      expect(response.status).toBe(500)
      const xml = await response.text()
      expect(xml).toContain('<Code>InternalError</Code>')
      expect(xml).not.toContain('secret detail')
      spy.mockRestore()
    })
  })
})

describe('S3 operations', () => {
  describe('buckets', () => {
    it('are created, listed, found and deleted', () => {
      const bucket = uniqueBucket()
      expect(op('createBucketOp', { Bucket: bucket })).toEqual({ Location: `/${bucket}` })
      expect(op('headBucketOp', { Bucket: bucket })).toEqual({ BucketRegion: region })

      const listed = op('listBucketsOp', {}).Buckets
      expect(listed).toContainEqual({ Name: bucket, CreationDate: expect.any(String) })
      expect(Date.parse(listed.find((b: Named) => b.Name === bucket).CreationDate)).toBeGreaterThan(Date.now() - 10000)

      expect(op('deleteBucketOp', { Bucket: bucket })).toEqual({})
      expect(errorOf(() => op('headBucketOp', { Bucket: bucket })).type).toBe('NotFound')
      expect(op('listBucketsOp', {}).Buckets.map((b: Named) => b.Name)).not.toContain(bucket)
    })

    it('cannot be created twice', () => {
      const bucket = bucketWith()
      expect(errorOf(() => op('createBucketOp', { Bucket: bucket })).type).toBe('BucketAlreadyOwnedByYou')
    })

    it('have names that are unique across all accounts', () => {
      const bucket = bucketWith({ k: 'v' })
      expect(op('listBucketsOp', {}, { account: otherAccount }).Buckets.map((b: Named) => b.Name)).not.toContain(bucket)
      expect(errorOf(() => op('createBucketOp', { Bucket: bucket }, { account: otherAccount }))).toMatchObject({ type: 'BucketAlreadyExists', status: 409 })
      expect(errorOf(() => op('createBucketOp', { Bucket: bucket }))).toMatchObject({ type: 'BucketAlreadyOwnedByYou', status: 409 })
      expect(s3Storage.findBucketOwner(bucket)).toBe(account)
      expect(s3Storage.findBucketOwner('no-such-bucket')).toBeUndefined()
    })

    it('with names that differ only in dots and dashes are different buckets', () => {
      const dashed = `dots-${Date.now()}`
      const dotted = dashed.replace('-', '.')
      op('createBucketOp', { Bucket: dashed })
      expect(s3Storage.findBucketOwner(dotted)).toBeUndefined()
      op('createBucketOp', { Bucket: dotted }, { account: otherAccount })
      expect([s3Storage.findBucketOwner(dashed), s3Storage.findBucketOwner(dotted)]).toEqual([account, otherAccount])
    })

    it('can only be deleted when empty, which they are again once every object is deleted', () => {
      const bucket = bucketWith({ a: '1', 'dir/b': '2' })
      expect(errorOf(() => op('deleteBucketOp', { Bucket: bucket })).type).toBe('BucketNotEmpty')
      op('deleteObjectOp', { Bucket: bucket, Key: 'a' })
      expect(errorOf(() => op('deleteBucketOp', { Bucket: bucket })).type).toBe('BucketNotEmpty')
      op('deleteObjectOp', { Bucket: bucket, Key: 'dir/b' })
      expect(op('deleteBucketOp', { Bucket: bucket })).toEqual({})
    })

    it('that do not exist cannot be deleted', () => {
      expect(errorOf(() => op('deleteBucketOp', { Bucket: 'no-such-bucket' })).type).toBe('NoSuchBucket')
    })

    it.each(['createBucketOp', 'deleteBucketOp', 'headBucketOp', 'listObjectsV2Op', 'getBucketPolicyOp', 'putObjectOp', 'getObjectOp', 'headObjectOp', 'deleteObjectOp'])('%s requires a bucket', name => {
      expect(errorOf(() => op(name, { Key: 'k' })).type).toBe('MissingParameter')
    })
  })

  describe('bucket policies', () => {
    const statement = (bucket: string, extra: Record<string, unknown> = {}) =>
      ({ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${bucket}/*`, ...extra })
    const policyOf = (...statements: Record<string, unknown>[]) => JSON.stringify({ Version: '2012-10-17', Statement: statements })

    it('are put, read back and deleted', () => {
      const bucket = bucketWith()
      const policy = policyOf(statement(bucket))
      expect(errorOf(() => op('getBucketPolicyOp', { Bucket: bucket })).type).toBe('NoSuchBucketPolicy')
      expect(op('putBucketPolicyOp', { Bucket: bucket, Policy: policy })).toEqual({})
      expect(JSON.parse(op('getBucketPolicyOp', { Bucket: bucket }).Policy)).toEqual(JSON.parse(policy))
      op('deleteBucketPolicyOp', { Bucket: bucket })
      expect(errorOf(() => op('getBucketPolicyOp', { Bucket: bucket })).type).toBe('NoSuchBucketPolicy')
    })

    it('need a bucket that exists', () => {
      expect(errorOf(() => op('putBucketPolicyOp', { Bucket: bucketWith() })).type).toBe('MissingParameter')
      expect(errorOf(() => op('putBucketPolicyOp', { Bucket: 'no-such-bucket', Policy: '{}' })).type).toBe('NoSuchBucket')
      expect(errorOf(() => op('getBucketPolicyOp', { Bucket: 'no-such-bucket' })).type).toBe('NoSuchBucket')
      expect(errorOf(() => op('deleteBucketPolicyOp', { Bucket: 'no-such-bucket' })).type).toBe('NoSuchBucket')
    })

    it('are managed by the owning account only: another account gets 405', () => {
      const bucket = bucketWith()
      op('putBucketPolicyOp', { Bucket: bucket, Policy: policyOf(statement(bucket)) })
      const fromOther = { callerAccount: otherAccount }
      expect(errorOf(() => ops.getBucketPolicyOp({ params: { Bucket: bucket }, account, region, ...fromOther }))).toMatchObject({ type: 'MethodNotAllowed', status: 405 })
      expect(errorOf(() => ops.putBucketPolicyOp({ params: { Bucket: bucket, Policy: policyOf(statement(bucket)) }, account, region, ...fromOther })).status).toBe(405)
      expect(errorOf(() => ops.deleteBucketPolicyOp({ params: { Bucket: bucket }, account, region, ...fromOther })).status).toBe(405)
    })

    describe('are checked when they are put', () => {
      let bucket: string
      beforeAll(() => {
        bucket = bucketWith()
        iam.createRole(otherAccount, { roleName: 'partner', assumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] } })
      })
      const put = (policy: string) => op('putBucketPolicyOp', { Bucket: bucket, Policy: policy })
      const rejection = (policy: string) => errorOf(() => put(policy))

      it('accept the principals that exist, in every form', () => {
        for (const principal of [
          '*', { AWS: '*' }, { AWS: otherAccount }, { AWS: `arn:aws:iam::${otherAccount}:root` },
          { AWS: [`arn:aws:iam::${otherAccount}:role/partner`, `arn:aws:sts::${otherAccount}:assumed-role/partner/s`] },
          { Service: 'logging.s3.amazonaws.com' },
        ]) {
          expect(put(policyOf(statement(bucket, { Principal: principal })))).toEqual({})
        }
        expect(put(policyOf(statement(bucket, { Action: ['s3:Get*', 's3:ListBucket', '*'], Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/a/*`] })))).toEqual({})
      })

      it.each([
        ['not JSON', '{nope', "Policies must be valid JSON and the first byte must be '{'"],
        ['not an object', '[]', "Policies must be valid JSON and the first byte must be '{'"],
        ['no statements', JSON.stringify({ Version: '2012-10-17', Statement: [] }), 'Missing required field Statement'],
        ['a bad version', JSON.stringify({ Version: '2020-01-01', Statement: [{}] }), 'The policy must contain a valid version string'],
      ])('refuse %s', (_, policy, message) => {
        expect(rejection(policy)).toEqual({ type: 'MalformedPolicy', status: 400, message })
      })

      it('refuse statements without what they need, or with a bad effect', () => {
        const without = (field: string) => { const s: Record<string, unknown> = statement(bucket); delete s[field]; return policyOf(s) }
        expect(rejection(without('Effect')).message).toBe('Missing required field Effect')
        expect(rejection(without('Principal')).message).toBe('Missing required field Principal')
        expect(rejection(without('Action')).message).toBe('Missing required field Action')
        expect(rejection(without('Resource')).message).toBe('Missing required field Resource')
        expect(rejection(policyOf(statement(bucket, { Effect: 'Maybe' }))).message).toBe('Invalid effect: Maybe')
      })

      it('refuse resources outside the bucket and actions of other services', () => {
        for (const resource of ['*', 'arn:aws:s3:::other/*', `arn:aws:s3:::${bucket}x/*`, `arn:aws:s3:::${bucket.slice(0, -1)}*`]) {
          expect(rejection(policyOf(statement(bucket, { Resource: resource })))).toMatchObject({ type: 'MalformedPolicy', message: 'Policy has invalid resource' })
        }
        expect(rejection(policyOf(statement(bucket, { Action: 'ec2:DescribeVpcs' }))).message).toBe('Policy has invalid action')
      })

      it('refuse principals that do not exist or are malformed', () => {
        for (const principal of [
          { AWS: `arn:aws:iam::${otherAccount}:role/nobody` }, { AWS: `arn:aws:iam::${otherAccount}:user/alice` }, { AWS: '12345' },
          { AWS: 'arn:aws:iam::nope:root' }, {}, 'someone', { Weird: 'x' },
        ]) {
          expect(rejection(policyOf(statement(bucket, { Principal: principal })))).toMatchObject({ type: 'MalformedPolicy', message: 'Invalid principal in policy' })
        }
        expect(rejection(policyOf(statement(bucket, { Principal: { CanonicalUser: 'abc' } })))).toMatchObject({ type: 'NotImplemented', status: 501 })
      })
    })
  })

  describe('objects', () => {
    it('round-trip binary content with its metadata', () => {
      const bucket = bucketWith()
      const body = Buffer.from([0, 1, 2, 253, 254, 255])
      const md5 = `"${createHash('md5').update(body).digest('hex')}"`
      expect(op('putObjectOp', { Bucket: bucket, Key: 'bin/data.bin', Body: body, ContentType: 'application/octet-stream' })).toEqual({ VersionId: 'v1', ETag: md5 })

      const got = op('getObjectOp', { Bucket: bucket, Key: 'bin/data.bin' })
      expect(Buffer.isBuffer(got.Body)).toBe(true)
      expect(got).toMatchObject({ Body: body, ContentLength: 6, ContentType: 'application/octet-stream', ETag: md5, VersionId: 'v1' })
      expect(got.ServerSideEncryption).toBeUndefined()

      expect(op('headObjectOp', { Bucket: bucket, Key: 'bin/data.bin' })).toEqual({
        ContentLength: 6, ContentType: 'application/octet-stream', ETag: md5, VersionId: 'v1', LastModified: got.LastModified,
        ServerSideEncryption: undefined, SSEKMSKeyId: undefined,
      })
    })

    it('can be empty', () => {
      const bucket = bucketWith()
      op('putObjectOp', { Bucket: bucket, Key: 'empty', Body: Buffer.alloc(0), ContentType: 'text/plain' })
      expect(op('getObjectOp', { Bucket: bucket, Key: 'empty' })).toMatchObject({ Body: Buffer.alloc(0), ContentLength: 0 })
    })

    it('are overwritten by a new version', () => {
      const bucket = bucketWith({ k: 'one' })
      expect(op('putObjectOp', { Bucket: bucket, Key: 'k', Body: Buffer.from('two'), ContentType: 'text/plain' }).VersionId).toBe('v2')
      expect(op('getObjectOp', { Bucket: bucket, Key: 'k' })).toMatchObject({ Body: Buffer.from('two'), VersionId: 'v2' })
      expect(op('listObjectsV2Op', { Bucket: bucket }).Contents).toEqual([expect.objectContaining({ Key: 'k', Size: 3 })])
    })

    it('are gone once deleted, and can be written again', () => {
      const bucket = bucketWith({ k: 'v', other: 'o' })
      expect(op('deleteObjectOp', { Bucket: bucket, Key: 'k' })).toEqual({ VersionId: 'v2' })
      expect(errorOf(() => op('getObjectOp', { Bucket: bucket, Key: 'k' })).type).toBe('NoSuchKey')
      expect(errorOf(() => op('headObjectOp', { Bucket: bucket, Key: 'k' })).type).toBe('NoSuchKey')
      expect(op('listObjectsV2Op', { Bucket: bucket }).Contents.map((o: Keyed) => o.Key)).toEqual(['other'])

      op('putObjectOp', { Bucket: bucket, Key: 'k', Body: Buffer.from('again'), ContentType: 'text/plain' })
      expect(op('getObjectOp', { Bucket: bucket, Key: 'k' }).Body).toEqual(Buffer.from('again'))
      expect(op('listObjectsV2Op', { Bucket: bucket }).Contents.map((o: Keyed) => o.Key)).toEqual(['k', 'other'])
    })

    it('that do not exist are NoSuchKey, in buckets that do not exist NoSuchBucket', () => {
      const bucket = bucketWith()
      expect(errorOf(() => op('getObjectOp', { Bucket: bucket, Key: 'nope' }))).toMatchObject({ type: 'NoSuchKey', message: 'The specified key does not exist.' })
      expect(errorOf(() => op('headObjectOp', { Bucket: bucket, Key: 'nope' })).type).toBe('NoSuchKey')
      for (const name of ['putObjectOp', 'getObjectOp', 'headObjectOp', 'deleteObjectOp']) {
        expect(errorOf(() => op(name, { Bucket: 'no-such-bucket', Key: 'k', Body: Buffer.from('x') })).type).toBe('NoSuchBucket')
      }
    })

    it.each(['putObjectOp', 'getObjectOp', 'headObjectOp', 'deleteObjectOp'])('%s requires a key', name => {
      expect(errorOf(() => op(name, { Bucket: bucketWith() })).type).toBe('MissingParameter')
    })
  })

  describe('ListObjectsV2', () => {
    const keys = ['a.txt', 'logs/2024/01.log', 'logs/2024/02.log', 'logs/2025/01.log', 'logs/readme', 'photos/cat.jpg', 'z']
    let bucket: string
    beforeAll(() => {
      bucket = bucketWith(Object.fromEntries(keys.map(k => [k, k])))
    })
    const list = (params: Record<string, unknown> = {}) => op('listObjectsV2Op', { Bucket: bucket, ...params })
    const keysOf = (result: Listing) => result.Contents.map((o: Keyed) => o.Key)
    const prefixesOf = (result: Listing) => result.CommonPrefixes.map(p => p.Prefix)

    it('lists every object in key order with its metadata', () => {
      const result = list()
      expect(keysOf(result)).toEqual(keys)
      expect(result).toMatchObject({ Name: bucket, Prefix: '', MaxKeys: 1000, KeyCount: 7, IsTruncated: false, CommonPrefixes: [] })
      expect(result.NextContinuationToken).toBeUndefined()
      expect(result.Contents[0]).toEqual({ Key: 'a.txt', Size: 5, ETag: expect.stringMatching(/^"[0-9a-f]{32}"$/), LastModified: expect.any(String), StorageClass: 'STANDARD' })
    })

    it('filters by prefix', () => {
      expect(keysOf(list({ Prefix: 'logs/2024/' }))).toEqual(['logs/2024/01.log', 'logs/2024/02.log'])
      expect(keysOf(list({ Prefix: 'nothing' }))).toEqual([])
    })

    it('groups keys by delimiter into common prefixes', () => {
      const top = list({ Delimiter: '/' })
      expect(keysOf(top)).toEqual(['a.txt', 'z'])
      expect(prefixesOf(top)).toEqual(['logs/', 'photos/'])
      expect(top.KeyCount).toBe(4)

      const logs = list({ Prefix: 'logs/', Delimiter: '/' })
      expect(keysOf(logs)).toEqual(['logs/readme'])
      expect(prefixesOf(logs)).toEqual(['logs/2024/', 'logs/2025/'])
    })

    it('pages with max-keys and continuation tokens, a common prefix counting as one entry', () => {
      const seen: string[] = []
      let token: string | undefined
      let pages = 0
      do {
        const page = list({ Delimiter: '/', MaxKeys: 1, ContinuationToken: token })
        expect(page.KeyCount).toBe(1)
        seen.push(...keysOf(page), ...prefixesOf(page))
        token = page.NextContinuationToken
        expect(page.IsTruncated).toBe(token !== undefined)
        pages++
      } while (token)
      expect(pages).toBe(4)
      expect(seen).toEqual(['a.txt', 'logs/', 'photos/', 'z'])
    })

    it('pages through all keys without delimiter', () => {
      const first = list({ MaxKeys: 3 })
      expect(keysOf(first)).toEqual(keys.slice(0, 3))
      const second = list({ MaxKeys: 3, ContinuationToken: first.NextContinuationToken })
      expect(second.ContinuationToken).toBe(first.NextContinuationToken)
      expect(keysOf(second)).toEqual(keys.slice(3, 6))
      const third = list({ MaxKeys: 3, ContinuationToken: second.NextContinuationToken })
      expect(keysOf(third)).toEqual(['z'])
      expect(third.IsTruncated).toBe(false)
    })

    it('starts after a key', () => {
      expect(keysOf(list({ StartAfter: 'logs/readme' }))).toEqual(['photos/cat.jpg', 'z'])
      expect(list({ StartAfter: 'logs/readme' }).StartAfter).toBe('logs/readme')
    })

    it('caps max-keys at 1000 and allows 0', () => {
      expect(list({ MaxKeys: 5000 }).MaxKeys).toBe(1000)
      const none = list({ MaxKeys: 0 })
      expect([none.KeyCount, keysOf(none)]).toEqual([0, []])
    })

    it('url-encodes keys and prefixes when asked', () => {
      const b = bucketWith({ 'a b/c&d.txt': 'x' })
      const result = op('listObjectsV2Op', { Bucket: b, Prefix: 'a b/', EncodingType: 'url' })
      expect(result).toMatchObject({ Prefix: 'a%20b/', EncodingType: 'url' })
      expect(keysOf(result)).toEqual(['a%20b/c%26d.txt'])
      expect(keysOf(op('listObjectsV2Op', { Bucket: b }))).toEqual(['a b/c&d.txt'])
    })

    it('needs a bucket that exists', () => {
      expect(errorOf(() => op('listObjectsV2Op', { Bucket: 'no-such-bucket' })).type).toBe('NoSuchBucket')
    })
  })

  describe('KMS default encryption', () => {
    const writer = `arn:aws:iam::${account}:role/writer`
    const reader = `arn:aws:iam::${account}:role/reader`
    const outsider = `arn:aws:iam::${account}:role/outsider`
    let bucket: string
    let keyId: string

    beforeAll(() => {
      keyId = createKey(account, 'bucket key', {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { AWS: [writer, reader] }, Action: 'kms:Decrypt', Resource: '*' },
          { Effect: 'Allow', Principal: { AWS: writer }, Action: 'kms:GenerateDataKey', Resource: '*' },
        ],
      }).keyMetadata.keyId
      bucket = bucketWith()
      s3Storage.setBucketEncryption(account, bucket, keyId)
    })

    it('encrypts what an allowed principal writes and lets allowed principals read it', () => {
      const put = op('putObjectOp', { Bucket: bucket, Key: 'secret', Body: Buffer.from('s3cr3t'), ContentType: 'text/plain' }, { principal: writer })
      expect(put).toMatchObject({ VersionId: 'v1', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: keyId })

      const got = op('getObjectOp', { Bucket: bucket, Key: 'secret' }, { principal: reader })
      expect(got).toMatchObject({ Body: Buffer.from('s3cr3t'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: keyId })
      expect(op('headObjectOp', { Bucket: bucket, Key: 'secret' })).toMatchObject({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: keyId })
    })

    it('refuses a write without kms:GenerateDataKey and logs the denial', () => {
      expect(errorOf(() => op('putObjectOp', { Bucket: bucket, Key: 'nope', Body: Buffer.from('x'), ContentType: 'text/plain' }, { principal: reader })))
        .toMatchObject({ type: 'AccessDenied', status: 403 })
      expect(errorOf(() => op('getObjectOp', { Bucket: bucket, Key: 'nope' })).type).toBe('NoSuchKey')
      expect(readCloudTrailEvents(account, { principal: reader, action: 'GenerateDataKey', authorizationDecision: 'deny' })).toHaveLength(1)
    })

    it('refuses a read without kms:Decrypt and logs the denial', () => {
      op('putObjectOp', { Bucket: bucket, Key: 'secret2', Body: Buffer.from('x'), ContentType: 'text/plain' }, { principal: writer })
      expect(errorOf(() => op('getObjectOp', { Bucket: bucket, Key: 'secret2' }, { principal: outsider }))).toMatchObject({ type: 'AccessDenied', status: 403 })
      expect(readCloudTrailEvents(account, { principal: outsider, action: 'Decrypt', authorizationDecision: 'deny' })).toHaveLength(1)
      expect(readCloudTrailEvents(account, { principal: writer, action: 'GenerateDataKey', authorizationDecision: 'allow' }).length).toBeGreaterThan(0)
    })
  })
})

describe('S3 service (HTTP through the registry)', () => {
  const headers = (principal: string, extra: Record<string, string> = {}) => ({
    'x-aws-principal': principal,
    'x-aws-userid': 'AROAEXAMPLE',
    authorization: `AWS4-HMAC-SHA256 Credential=KEY/20250101/${region}/s3/aws4_request, SignedHeaders=host, Signature=abc`,
    ...extra,
  })

  async function call(method: string, path: string, { principal = ADMIN, body, extra }: { principal?: string; body?: BodyInit; extra?: Record<string, string> } = {}) {
    const response: Response = await s3.post(new Request(`http://localhost:3000${path}`, { method, body, headers: headers(principal, extra) }))
    const text = method === 'HEAD' ? '' : await response.text()
    return { status: response.status, headers: response.headers, text, code: text.match(/<Code>([^<]+)<\/Code>/)?.[1] }
  }

  it('serves a full bucket and object lifecycle as S3 does', async () => {
    const bucket = uniqueBucket()
    expect((await call('PUT', `/${bucket}`)).status).toBe(200)
    expect((await call('HEAD', `/${bucket}`)).headers.get('x-amz-bucket-region')).toBe(region)

    const put = await call('PUT', `/${bucket}/docs/a%20b.txt`, { body: 'hello', extra: { 'content-type': 'text/plain' } })
    expect(put.status).toBe(200)
    expect(put.headers.get('etag')).toBe(`"${createHash('md5').update('hello').digest('hex')}"`)

    const got = await call('GET', `/${bucket}/docs/a%20b.txt`)
    expect([got.status, got.text, got.headers.get('content-type')]).toEqual([200, 'hello', 'text/plain'])

    const listed = await call('GET', `/${bucket}?list-type=2&delimiter=%2F`)
    expect(listed.text).toContain('<CommonPrefixes><Prefix>docs/</Prefix></CommonPrefixes>')

    expect((await call('GET', '/')).text).toContain(`<Name>${bucket}</Name>`)
    expect((await call('DELETE', `/${bucket}/docs/a%20b.txt`)).status).toBe(204)
    expect((await call('GET', `/${bucket}/docs/a%20b.txt`))).toMatchObject({ status: 404, code: 'NoSuchKey' })
    expect((await call('DELETE', `/${bucket}`)).status).toBe(204)
    expect((await call('GET', `/${bucket}?list-type=2`))).toMatchObject({ status: 404, code: 'NoSuchBucket' })
  })

  it('serves virtual-hosted requests', async () => {
    const bucket = uniqueBucket()
    const vhost = { [VHOST_BUCKET_HEADER]: bucket }
    expect((await call('PUT', '/', { extra: vhost })).status).toBe(200)
    expect((await call('PUT', '/k', { body: 'v', extra: vhost })).status).toBe(200)
    expect((await call('GET', '/k', { extra: vhost })).text).toBe('v')
  })

  it('answers bad requests with S3 XML errors', async () => {
    expect(await call('PUT', '/Bad_Name')).toMatchObject({ status: 400, code: 'InvalidBucketName' })
    expect(await call('PUT', '/some-bucket?versioning')).toMatchObject({ status: 501, code: 'NotImplemented' })
  })

  it('refuses requests in a Region the account has not enabled', async () => {
    const response: Response = await s3.post(new Request('http://localhost:3000/', {
      headers: { ...headers(ADMIN), authorization: 'AWS4-HMAC-SHA256 Credential=KEY/20250101/af-south-1/s3/aws4_request, SignedHeaders=host, Signature=abc' },
    }))
    expect(response.status).toBe(401)
  })

  describe('authorization', () => {
    const reader = `arn:aws:sts::${account}:assumed-role/s3-reader/session`
    let bucket: string

    beforeAll(async () => {
      bucket = uniqueBucket()
      await call('PUT', `/${bucket}`)
      await call('PUT', `/${bucket}/public/a.txt`, { body: 'a' })
      await call('PUT', `/${bucket}/private/b.txt`, { body: 'b' })
      iam.createRole(account, { roleName: 's3-reader', assumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: 'sts:AssumeRole' }] } })
      iam.putRolePolicy(account, 's3-reader', 'read-public', {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: 's3:GetObject', Resource: `arn:aws:s3:::${bucket}/public/*` },
          { Effect: 'Allow', Action: 's3:ListBucket', Resource: `arn:aws:s3:::${bucket}` },
        ],
      })
    })

    it('checks the IAM action and the object ARN', async () => {
      expect((await call('GET', `/${bucket}/public/a.txt`, { principal: reader })).text).toBe('a')
      expect((await call('HEAD', `/${bucket}/public/a.txt`, { principal: reader })).status).toBe(200)
      expect(await call('GET', `/${bucket}/private/b.txt`, { principal: reader })).toMatchObject({ status: 403, code: 'AccessDenied' })
      expect(await call('PUT', `/${bucket}/public/c.txt`, { principal: reader, body: 'c' })).toMatchObject({ status: 403, code: 'AccessDenied' })
      expect(await call('DELETE', `/${bucket}/public/a.txt`, { principal: reader })).toMatchObject({ status: 403, code: 'AccessDenied' })
    })

    it('checks s3:ListBucket on the bucket ARN and s3:ListAllMyBuckets', async () => {
      expect((await call('GET', `/${bucket}?list-type=2`, { principal: reader })).status).toBe(200)
      expect((await call('HEAD', `/${bucket}`, { principal: reader })).status).toBe(200)
      expect(await call('GET', '/', { principal: reader })).toMatchObject({ status: 403, code: 'AccessDenied' })
      expect(await call('DELETE', `/${bucket}`, { principal: reader })).toMatchObject({ status: 403, code: 'AccessDenied' })
    })

    it('records the decisions in CloudTrail without the object body', () => {
      const denied = readCloudTrailEvents(account, { principal: reader, action: 'PutObject', authorizationDecision: 'deny' })
      expect(denied).toHaveLength(1)
      expect(denied[0].resource).toBe(`arn:aws:s3:::${bucket}/public/c.txt`)
      expect(denied[0].parameters).toEqual({ Bucket: bucket, Key: 'public/c.txt', ContentType: expect.any(String) })
      expect(readCloudTrailEvents(account, { principal: reader, action: 'ListBucket', authorizationDecision: 'allow' }).length).toBe(2)
    })
  })

  describe('across accounts', () => {
    // Account A (`account`) owns the buckets; account B (`otherAccount`) calls them.
    const session = (acct: string, role: string) => `arn:aws:sts::${acct}:assumed-role/${role}/session`
    const roleArn = (acct: string, role: string) => `arn:aws:iam::${acct}:role/${role}`
    const CONSUMER = session(otherAccount, 'consumer')     // B, its own policies allow all of S3
    const STRANGER = session(otherAccount, 'stranger')     // B, its own policies allow all of S3
    const NO_GRANTS = session(otherAccount, 'no-grants')   // B, no identity-based policy at all
    const B_ADMIN = session(otherAccount, 'admin')         // B, not in IAM state: not restricted by identity-based policies
    const INSIDER = session(account, 'insider')            // A, no identity-based policy at all
    const everything = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] }
    const trust = { Version: '2012-10-17', Statement: [] }

    beforeAll(() => {
      for (const [acct, name, policy] of [
        [otherAccount, 'consumer', everything], [otherAccount, 'stranger', everything], [otherAccount, 'no-grants', undefined],
        [otherAccount, 'denies-get', { Version: '2012-10-17', Statement: [...everything.Statement, { Effect: 'Deny', Action: 's3:GetObject', Resource: '*' }] }],
        [account, 'insider', undefined],
      ] as const) {
        iam.createRole(acct, { roleName: name, assumeRolePolicyDocument: trust })
        if (policy) iam.putRolePolicy(acct, name, 'p', policy)
      }
    })

    const policyOf = (...statements: Record<string, unknown>[]) => JSON.stringify({ Version: '2012-10-17', Statement: statements })
    const grant = (bucket: string, principal: unknown, actions: string[], extra: Record<string, unknown> = {}) =>
      ({ Effect: 'Allow', Principal: principal, Action: actions, Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`], ...extra })

    // A bucket of account A with one object and the given bucket policy.
    async function sharedBucket(...statements: Array<(bucket: string) => Record<string, unknown>[]>) {
      const bucket = uniqueBucket()
      expect((await call('PUT', `/${bucket}`)).status).toBe(200)
      await call('PUT', `/${bucket}/doc.txt`, { body: 'from A' })
      const policy = statements.flatMap(f => f(bucket))
      if (policy.length) {
        expect((await call('PUT', `/${bucket}?policy`, { body: policyOf(...policy) })).status).toBe(204)
      }
      return bucket
    }
    const reason = (text: string) => text.match(/because [^<]+|with an explicit deny in an? [^<]+/)?.[0]

    it('deny another account without a bucket policy, whatever its own policies allow', async () => {
      const bucket = await sharedBucket()
      for (const principal of [CONSUMER, B_ADMIN]) {
        const answer = await call('GET', `/${bucket}/doc.txt`, { principal })
        expect(answer).toMatchObject({ status: 403, code: 'AccessDenied' })
        expect(reason(answer.text)).toBe('because no resource-based policy allows the s3:GetObject action')
        expect((await call('PUT', `/${bucket}/x`, { principal, body: 'x' })).status).toBe(403)
        expect((await call('GET', `/${bucket}?list-type=2`, { principal })).status).toBe(403)
        expect((await call('HEAD', `/${bucket}`, { principal })).status).toBe(403)
      }
    })

    it('let an account the bucket policy names in, for what its own policies also allow', async () => {
      const bucket = await sharedBucket(b => [grant(b, { AWS: otherAccount }, ['s3:GetObject', 's3:PutObject', 's3:ListBucket'])])

      expect((await call('GET', `/${bucket}/doc.txt`, { principal: CONSUMER })).text).toBe('from A')
      expect((await call('GET', `/${bucket}/doc.txt`, { principal: B_ADMIN })).text).toBe('from A')
      expect((await call('PUT', `/${bucket}/from-b.txt`, { principal: CONSUMER, body: 'from B' })).status).toBe(200)
      expect((await call('GET', `/${bucket}?list-type=2`, { principal: CONSUMER })).text).toContain('<Key>from-b.txt</Key>')

      // the object is in the bucket of A, for A to read
      expect(s3Storage.getObject(account, bucket, 'from-b.txt')?.content.toString()).toBe('from B')
      expect(s3Storage.getObject(otherAccount, bucket, 'from-b.txt')).toBeNull()
      expect((await call('GET', `/${bucket}/from-b.txt`)).text).toBe('from B')

      const noIdentity = await call('GET', `/${bucket}/doc.txt`, { principal: NO_GRANTS })
      expect([noIdentity.status, reason(noIdentity.text)]).toEqual([403, 'because no identity-based policy allows the s3:GetObject action'])
      const notGranted = await call('DELETE', `/${bucket}/doc.txt`, { principal: CONSUMER })
      expect([notGranted.status, reason(notGranted.text)]).toEqual([403, 'because no resource-based policy allows the s3:DeleteObject action'])
    })

    it('let only the role a bucket policy names in, as the role ARN or as one session', async () => {
      const bucket = await sharedBucket(b => [grant(b, { AWS: roleArn(otherAccount, 'consumer') }, ['s3:GetObject'])])
      expect((await call('GET', `/${bucket}/doc.txt`, { principal: CONSUMER })).status).toBe(200)
      expect((await call('GET', `/${bucket}/doc.txt`, { principal: STRANGER })).status).toBe(403)

      const one = await sharedBucket(b => [grant(b, { AWS: session(otherAccount, 'stranger') }, ['s3:GetObject'])])
      expect((await call('GET', `/${one}/doc.txt`, { principal: STRANGER })).status).toBe(200)
      expect((await call('GET', `/${one}/doc.txt`, { principal: session(otherAccount, 'stranger').replace(/session$/, 'other') })).status).toBe(403)
    })

    it('let everyone in with Principal "*"', async () => {
      const bucket = await sharedBucket(b => [grant(b, '*', ['s3:GetObject'])])
      for (const principal of [CONSUMER, STRANGER, B_ADMIN, INSIDER]) {
        expect((await call('GET', `/${bucket}/doc.txt`, { principal })).status).toBe(200)
      }
      // ... but someone whose own policies say nothing from another account still needs them
      expect((await call('GET', `/${bucket}/doc.txt`, { principal: NO_GRANTS })).status).toBe(403)
    })

    it('let an explicit deny win, in the bucket policy (also for the owning account) and in identity-based policies', async () => {
      const bucket = await sharedBucket(b => [
        grant(b, '*', ['s3:GetObject']),
        { Effect: 'Deny', Principal: { AWS: account }, Action: 's3:GetObject', Resource: `arn:aws:s3:::${b}/secret/*` },
      ])
      await call('PUT', `/${bucket}/secret/x`, { body: 'x' })
      const denied = await call('GET', `/${bucket}/secret/x`)
      expect([denied.status, reason(denied.text)]).toEqual([403, 'with an explicit deny in a resource-based policy'])
      expect((await call('GET', `/${bucket}/doc.txt`)).status).toBe(200)
      expect((await call('GET', `/${bucket}/secret/x`, { principal: CONSUMER })).status).toBe(200)

      const own = await call('GET', `/${bucket}/doc.txt`, { principal: session(otherAccount, 'denies-get') })
      expect([own.status, reason(own.text)]).toEqual([403, 'with an explicit deny in an identity-based policy'])
    })

    it('within the owning account, grant with a bucket policy that names the role, not with one that names the account', async () => {
      expect((await call('GET', `/${await sharedBucket()}/doc.txt`, { principal: INSIDER })).status).toBe(403)
      const named = await sharedBucket(b => [grant(b, { AWS: roleArn(account, 'insider') }, ['s3:GetObject'])])
      expect((await call('GET', `/${named}/doc.txt`, { principal: INSIDER })).status).toBe(200)
      const delegated = await sharedBucket(b => [grant(b, { AWS: `arn:aws:iam::${account}:root` }, ['s3:GetObject'])])
      const answer = await call('GET', `/${delegated}/doc.txt`, { principal: INSIDER })
      expect([answer.status, reason(answer.text)]).toEqual([403, 'because no identity-based policy allows the s3:GetObject action'])
    })

    it('keep the bucket out of the bucket list of another account and its policy with the owner (405)', async () => {
      const bucket = await sharedBucket(b => [grant(b, { AWS: otherAccount }, ['s3:GetObject', 's3:GetBucketPolicy', 's3:PutBucketPolicy'])])
      expect((await call('GET', '/', { principal: CONSUMER })).text).not.toContain(`<Name>${bucket}</Name>`)
      expect((await call('GET', '/')).text).toContain(`<Name>${bucket}</Name>`)
      expect(await call('GET', `/${bucket}?policy`, { principal: CONSUMER })).toMatchObject({ status: 405, code: 'MethodNotAllowed' })
      expect(await call('PUT', `/${bucket}?policy`, { principal: CONSUMER, body: policyOf(grant(bucket, '*', ['s3:*'])) })).toMatchObject({ status: 405 })
      expect(await call('DELETE', `/${bucket}?policy`, { principal: CONSUMER })).toMatchObject({ status: 403, code: 'AccessDenied' })
    })

    it('refuse a bucket name another account has taken', async () => {
      const bucket = await sharedBucket()
      expect(await call('PUT', `/${bucket}`, { principal: CONSUMER })).toMatchObject({ status: 409, code: 'BucketAlreadyExists' })
      expect(await call('PUT', `/${bucket}`)).toMatchObject({ status: 409, code: 'BucketAlreadyOwnedByYou' })
    })

    it('check ExpectedBucketOwner', async () => {
      const bucket = await sharedBucket(b => [grant(b, { AWS: otherAccount }, ['s3:GetObject'])])
      const expecting = (owner: string) => ({ principal: CONSUMER, extra: { 'x-amz-expected-bucket-owner': owner } })
      expect((await call('GET', `/${bucket}/doc.txt`, expecting(account))).status).toBe(200)
      expect(await call('GET', `/${bucket}/doc.txt`, expecting(otherAccount))).toMatchObject({ status: 403, code: 'AccessDenied' })
    })

    it('refuse to guess about a bucket policy with a Condition or NotPrincipal', async () => {
      const conditional = await sharedBucket(b => [grant(b, { AWS: otherAccount }, ['s3:GetObject'], { Condition: { Bool: { 'aws:SecureTransport': 'true' } } })])
      expect(await call('GET', `/${conditional}/doc.txt`, { principal: CONSUMER })).toMatchObject({ status: 501, code: 'PolicyNotModelled' })
      const negated = await sharedBucket(b => [{ Effect: 'Deny', NotPrincipal: { AWS: account }, Action: 's3:*', Resource: `arn:aws:s3:::${b}/*` }])
      expect(await call('GET', `/${negated}/doc.txt`, { principal: CONSUMER })).toMatchObject({ status: 501, code: 'PolicyNotModelled' })
    })

    it('record the request in the trails of both accounts', async () => {
      const bucket = await sharedBucket(b => [grant(b, { AWS: otherAccount }, ['s3:GetObject'])])
      await call('GET', `/${bucket}/doc.txt`, { principal: STRANGER })
      await call('DELETE', `/${bucket}/doc.txt`, { principal: STRANGER })
      for (const acct of [account, otherAccount]) {
        const events = readCloudTrailEvents(acct, { principal: STRANGER }).filter((e: { resource: string }) => e.resource.startsWith(`arn:aws:s3:::${bucket}/`))
        expect(events.map((e: { action: string; authorizationDecision: string }) => `${e.action}:${e.authorizationDecision}`)).toEqual(['GetObject:allow', 'DeleteObject:deny'])
      }
    })

    it('use the KMS key of the owner for default encryption, and match key policy principals by account', async () => {
      const keyId = createKey(account, 'shared bucket key', {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { AWS: roleArn(otherAccount, 'consumer') }, Action: ['kms:GenerateDataKey', 'kms:Decrypt'], Resource: '*' }],
      }).keyMetadata.keyId
      const bucket = await sharedBucket(b => [grant(b, '*', ['s3:GetObject', 's3:PutObject'])])
      s3Storage.setBucketEncryption(account, bucket, keyId)

      const put = await call('PUT', `/${bucket}/enc.txt`, { principal: CONSUMER, body: 'sealed' })
      expect([put.status, put.headers.get('x-amz-server-side-encryption-aws-kms-key-id')]).toEqual([200, keyId])
      expect((await call('GET', `/${bucket}/enc.txt`, { principal: CONSUMER })).text).toBe('sealed')
      // a role called "consumer" in the owning account is another role
      expect((await call('GET', `/${bucket}/enc.txt`, { principal: session(account, 'consumer') })).status).toBe(403)
    })
  })
})
