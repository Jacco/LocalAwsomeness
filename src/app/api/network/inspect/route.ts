import { NextResponse } from 'next/server'
import { BadReachRequest, inspectReach, type ReachRequest } from '../live'

// An internal endpoint, not an AWS API: the proxy lets unsigned requests through and this answers them without asking
// who is calling. It only reads the state of the simulator. POST a ReachRequest (see ../live.ts); the answer holds the
// trace as data and as text.
export async function POST(request: Request) {
  let body: ReachRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'The body is not JSON' }, { status: 400 })
  }
  try {
    return NextResponse.json(inspectReach(body))
  } catch (error) {
    if (error instanceof BadReachRequest) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    throw error
  }
}
