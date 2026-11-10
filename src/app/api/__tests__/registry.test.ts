import { setAuthorizer, type Authorizer } from '@/app/api/authorization'
import { AwsError } from '@/app/api/common'
import { JsonProtocol, QueryProtocol, RestJsonProtocol } from '@/app/api/protocols'
import { QueryParams } from '@/app/api/query'
import { defineService } from '@/app/api/registry'

const PRINCIPAL = 'arn:aws:sts::123456789012:assumed-role/admin/session'

function headers(extra: Record<string, string> = {}) {
  return {
    'x-aws-principal': PRINCIPAL,
    'x-aws-userid': 'AROAEXAMPLE:session',
    authorization: 'AWS4-HMAC-SHA256 Credential=KEY/20250101/eu-west-1/svc/aws4_request, SignedHeaders=host, Signature=abc',
    ...extra
  }
}

const allowAll: Authorizer = () => {}

describe('registry', () => {
  afterEach(() => setAuthorizer(allowAll))

  describe('query protocol', () => {
    const calls: unknown[] = []
    const service = defineService({
      iamPrefix: 'iam',
      protocol: new QueryProtocol('https://iam.amazonaws.com/doc/2010-05-08/', '2010-05-08'),
      operations: {
        GetThing: ({ account, params }: { account: string; params: QueryParams }) => {
          calls.push({ account, name: params.required('Name') })
          return { Thing: { Name: params.required('Name') } }
        },
        Fails: () => { throw new AwsError('NoSuchEntity', 'nope', 404) }
      }
    })

    const post = (body: string) => service.post(new Request('http://localhost/api/iam', { method: 'POST', body, headers: headers() }))

    it('decodes the form body, calls the handler with the caller context and encodes XML', async () => {
      const response = await post('Action=GetThing&Name=abc')

      expect(response.status).toBe(200)
      const xml = await response.text()
      expect(xml).toContain('<GetThingResponse')
      expect(xml).toContain('<Name>abc</Name>')
      expect(calls).toContainEqual({ account: '123456789012', name: 'abc' })
    })

    it('encodes AwsError as an XML error with its status', async () => {
      const response = await post('Action=Fails')
      expect(response.status).toBe(404)
      expect(await response.text()).toContain('<Code>NoSuchEntity</Code>')
    })

    it('rejects unknown actions', async () => {
      const response = await post('Action=Nope')
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('Could not find operation Nope for version 2010-05-08')
    })

    it('does not treat Object.prototype members as operations', async () => {
      expect((await post('Action=constructor')).status).toBe(400)
    })
  })

  describe('json protocol', () => {
    const service = defineService({
      iamPrefix: 'ssm',
      protocol: new JsonProtocol('1.1'),
      operations: {
        Echo: ({ region, params }) => ({ region, got: params })
      }
    })

    it('takes the action from x-amz-target and the region from the credential scope', async () => {
      const response = await service.post(new Request('http://localhost/api/ssm', {
        method: 'POST',
        body: JSON.stringify({ a: 1 }),
        headers: headers({ 'x-amz-target': 'AmazonSSM.Echo' })
      }))

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/x-amz-json-1.1')
      expect(await response.json()).toEqual({ region: 'eu-west-1', got: { a: 1 } })
    })

    it('takes the action from the route for dynamic [action] routes', async () => {
      const response = await service.postDynamic(
        new Request('http://localhost/api/ssm', { method: 'POST', body: '', headers: headers() }),
        { params: Promise.resolve({ action: 'Echo' }) }
      )
      expect(await response.json()).toEqual({ region: 'eu-west-1', got: {} })
    })

    it('returns an AWS-shaped error for unknown operations and invalid bodies', async () => {
      const unknown = await service.postDynamic(
        new Request('http://localhost/api/ssm', { method: 'POST', body: '{}', headers: headers() }),
        { params: Promise.resolve({ action: 'Missing' }) }
      )
      expect(unknown.status).toBe(400)
      expect(unknown.headers.get('x-amzn-errortype')).toBe('UnknownOperationException')

      const invalid = await service.postDynamic(
        new Request('http://localhost/api/ssm', { method: 'POST', body: '{nope', headers: headers() }),
        { params: Promise.resolve({ action: 'Echo' }) }
      )
      expect(invalid.status).toBe(400)
      expect(invalid.headers.get('x-amzn-errortype')).toBe('SerializationException')
    })

    it('turns unexpected errors into a 500 ServiceException', async () => {
      const broken = defineService({
        iamPrefix: 'ssm',
        protocol: new JsonProtocol('1.1'),
        operations: { Boom: () => { throw new Error('kaput') } }
      })
      const response = await broken.postAction('Boom')(new Request('http://localhost/x', { method: 'POST', headers: headers() }))
      expect(response.status).toBe(500)
      expect(response.headers.get('x-amzn-errortype')).toBe('ServiceException')
    })
  })

  describe('rest json protocol', () => {
    const service = defineService({
      iamPrefix: 'account',
      protocol: new RestJsonProtocol(),
      operations: {
        Get: () => ({ ok: true }),
        Nothing: () => undefined,
        Missing: () => { throw new AwsError('ResourceNotFoundException', 'gone', 404) }
      }
    })
    const call = (action: string) => service.postAction(action)(new Request('http://localhost/x', { method: 'POST', headers: headers() }))

    it('returns JSON, an empty body for void operations, and message + error type on failure', async () => {
      expect(await (await call('Get')).json()).toEqual({ ok: true })
      expect(await (await call('Nothing')).text()).toBe('')

      const failed = await call('Missing')
      expect(failed.status).toBe(404)
      expect(failed.headers.get('x-amzn-errortype')).toBe('ResourceNotFoundException')
      expect(await failed.json()).toEqual({ message: 'gone' })
    })
  })

  describe('authorization hook', () => {
    const service = defineService({
      iamPrefix: 'ssm',
      protocol: new JsonProtocol(),
      operations: {
        Plain: () => ({}),
        Declared: {
          handler: () => ({}),
          action: 'ssm:GetParameter',
          resources: ({ account, params }) => [`arn:aws:ssm:::${account}/${params.Name}`]
        }
      }
    })
    const call = (action: string, body = '{}') =>
      service.postAction(action)(new Request('http://localhost/x', { method: 'POST', body, headers: headers() }))

    it('is called before the handler with the IAM action and resources', async () => {
      const authorizer = jest.fn()
      setAuthorizer(authorizer)

      await call('Plain')
      await call('Declared', JSON.stringify({ Name: 'p' }))

      expect(authorizer).toHaveBeenNthCalledWith(1, expect.objectContaining({
        principal: PRINCIPAL,
        action: 'ssm:Plain',
        resources: ['*']
      }))
      expect(authorizer).toHaveBeenNthCalledWith(2, expect.objectContaining({
        action: 'ssm:GetParameter',
        resources: ['arn:aws:ssm:::123456789012/p'],
        context: expect.objectContaining({ account: '123456789012', region: 'eu-west-1' })
      }))
    })

    it('stops the request when the authorizer denies it', async () => {
      const handler = jest.fn(() => ({}))
      const guarded = defineService({ iamPrefix: 'ssm', protocol: new JsonProtocol(), operations: { Run: handler } })
      setAuthorizer(() => { throw new AwsError('AccessDeniedException', 'denied', 403) })

      const response = await guarded.postAction('Run')(new Request('http://localhost/x', { method: 'POST', headers: headers() }))

      expect(response.status).toBe(403)
      expect(handler).not.toHaveBeenCalled()
    })
  })
})
