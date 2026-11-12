import { NextResponse } from 'next/server'
import { loadInvocations, loadLambda } from '../../data/lambda'
import { accountDirExists } from '../../data/store'

// An internal endpoint, not an AWS API (like /api/network/inspect): what the last invocations of a function did, with the
// log and the connections the code made and their traces. GET /api/lambda/inspect?account=&region=&function=
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams
  const account = query.get('account') ?? ''
  const region = query.get('region') ?? ''
  const name = query.get('function') ?? ''
  if (!accountDirExists(account) || !region) {
    return NextResponse.json({ error: 'Give an existing account and a region' }, { status: 400 })
  }
  const state = loadLambda({ account, region })
  if (!state.functions[name]) {
    return NextResponse.json({ error: `No function '${name}' in ${account}/${region}` }, { status: 404 })
  }
  return NextResponse.json({ function: state.functions[name].Configuration, invocations: loadInvocations({ account, region }, name) })
}
