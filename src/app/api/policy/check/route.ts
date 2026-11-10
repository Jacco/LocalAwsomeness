import { NextResponse } from 'next/server'
import { evaluateIdentityPolicies, PolicyNotModelled } from '../engine'
import { subjectOf } from '../identity'

// An internal endpoint, not an AWS API (like /api/network/inspect): "can this principal perform this action on this
// resource?", with every statement that was looked at and why it did or did not apply.
//   GET /api/policy/check?principal=<arn of a role or an assumed-role session>&action=ec2:DescribeVpcs&resource=*
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams
  const principal = query.get('principal')
  const action = query.get('action')
  if (!principal || !action) {
    return NextResponse.json({ error: 'Give a principal and an action' }, { status: 400 })
  }
  const subject = subjectOf(principal)
  if (!subject.restricted) {
    return NextResponse.json({ restricted: false, decision: 'allow', reason: `not restricted: ${subject.reason}` })
  }
  try {
    return NextResponse.json({ restricted: true, ...evaluateIdentityPolicies(subject.policies, action, query.get('resource') ?? '*') })
  } catch (error) {
    if (error instanceof PolicyNotModelled) {
      return NextResponse.json({ restricted: true, decision: 'not-modelled', reason: error.message })
    }
    throw error
  }
}
