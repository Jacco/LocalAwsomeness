import { NextResponse } from 'next/server'
import { BadReachRequest } from '../../network/live'
import { BadRunRequest, runInContext, type RunRequest } from '../../../../lib/lambda-runtime/run'

// An internal endpoint, not an AWS API (like /api/network/inspect): runs the code of the request as if it were somewhere
// in a VPC and answers with its output, the connections it made and the trace of each. Local dev server only.
export async function POST(request: Request) {
  let body: RunRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'The body is not JSON' }, { status: 400 })
  }
  try {
    return NextResponse.json(await runInContext({ simulatorUrl: new URL(request.url).origin, ...body }))
  } catch (error) {
    if (error instanceof BadRunRequest || error instanceof BadReachRequest) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    throw error
  }
}
