import { Sha256 } from '@aws-crypto/sha256-js'
import { SignatureV4 } from '@smithy/signature-v4'
import { NextRequest } from 'next/server'

// The proxy verifies SigV4 signatures by signing again exactly what the client signed. Operations of REST services carry
// parameters in the query string (Lambda: Qualifier, MaxItems, Marker); the query is part of what is signed.

jest.mock('@/app/api/db/credentials', () => ({
  findCredential: jest.fn(() => ({ secret: 'secret', principal: 'arn:aws:iam::123456789012:user/test', userId: 'AIDATEST' })),
}))

import { proxy } from '@/proxy'

const region = 'eu-west-1'

async function signed(path: string, query: Record<string, string | string[]>, search: string) {
  const host = 'lambda.eu-west-1.amazonaws.com'
  const signer = new SignatureV4({ credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' }, service: 'lambda', region, sha256: Sha256, applyChecksum: false })
  const request = await signer.sign({ method: 'GET', protocol: 'http:', hostname: host, path, query, headers: { host } })
  return new NextRequest(`http://${host}${path}${search}`, { method: 'GET', headers: request.headers as Record<string, string> })
}

const handle = (request: NextRequest) => proxy(request, {} as never)

describe('proxy and query strings', () => {
  it('verifies a request with a query string and keeps the query on the rewritten URL', async () => {
    const response = await handle(await signed('/2015-03-31/functions', { MaxItems: '5', Marker: 'a b' }, '?MaxItems=5&Marker=a%20b'))

    expect(response.status).toBe(200)
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'http://lambda.eu-west-1.amazonaws.com/api/lambda/2015-03-31/functions?MaxItems=5&Marker=a%20b',
    )
  })

  it('verifies a repeated query parameter', async () => {
    const response = await handle(await signed('/2015-03-31/functions', { Tag: ['a', 'b'] }, '?Tag=a&Tag=b'))
    expect(response.headers.get('x-middleware-rewrite')).toContain('?Tag=a&Tag=b')
  })

  it('rejects a request whose query string was changed after signing', async () => {
    const request = await signed('/2015-03-31/functions', { MaxItems: '5' }, '?MaxItems=50')
    const response = await handle(request)

    expect(response.status).toBe(403)
    expect(await response.text()).toContain('SignatureDoesNotMatch')
  })

  it('still verifies a request without a query string', async () => {
    const response = await handle(await signed('/2015-03-31/functions', {}, ''))
    expect(response.headers.get('x-middleware-rewrite')).toBe('http://lambda.eu-west-1.amazonaws.com/api/lambda/2015-03-31/functions')
  })
})
