import { NextResponse } from 'next/server'
import type { NextFetchEvent, NextRequest } from 'next/server'
import { SignatureV4 } from '@smithy/signature-v4'
import { Sha256 } from '@aws-crypto/sha256-js'
import { readFileSync } from 'fs'

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  console.log(req.headers)
  
  const requestHeaders = new Headers(req.headers)
  const keyid = req.headers.get('authorization')?.split(' ').at(1)?.split('=').at(-1)?.split('/').at(0)
  const service = req.headers.get('authorization')?.split(' ').at(1)?.split('=').at(-1)?.split('/').at(3)!
  const region = req.headers.get('authorization')?.split(' ').at(1)?.split('=').at(-1)?.split('/').at(2)!
  if (!service) {
    return NextResponse.next()
  }
  const tokens: any = JSON.parse(readFileSync('db/tokens.json').toString())
  const secret = tokens[keyid!]["secret"]
  requestHeaders.set('x-aws-principal', tokens[keyid!]["role"])
  const signer = new SignatureV4({
    credentials: {
      accessKeyId: keyid!,
      secretAccessKey: secret,
    },
    service: service,
    region: region,
    sha256: Sha256,
    applyChecksum: false, // TODO if the header is there x-amz-content-sha256
  })
  let toencode = []
  for(const header of req.headers) {
    if (header[0].startsWith('x-amz-') || header[0] == 'content-type' || header[0] == 'host') {
        toencode.push(header)
    }
  }
  const dt = req.headers.get('x-amz-date')!
  const dts = dt.substring(0, 4)+'-'+dt.substring(4, 6)+'-'+dt.substring(6,8)+'T'+dt.substring(9, 11)+':'+dt.substring(11, 13)+':'+dt.substring(13, 15)+'Z'
  const sig = await signer.sign({
    headers: Object.fromEntries(toencode),
    hostname: req.nextUrl.hostname,
    // query: req.nextUrl.,
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
    console.log('sig mismatch')
    return NextResponse.error()
  } else {
    // console.log('signatures match')
  }

  /*
    now that we know that this signagture is known we can set the account/role/user
  */
  const target = req.headers.get('x-amz-target')?.replace('.', '/')
  if (target) {
    console.log('using target')
    const destination = req.url + 'api/' + service + '/' + target
    const newurl = new URL(destination, req.url)
    return NextResponse.rewrite(newurl, {
        request: {
          headers: requestHeaders
        }
    })
  }
  if (service) {
    console.log('using service')
    const destination = req.nextUrl.protocol + req.nextUrl.host + '/api/' + service + req.nextUrl.pathname
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