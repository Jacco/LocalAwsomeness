// What the network model returns: the answer and the explanation in one value. The trace is the product (see
// docs/network-traces-plan.md): every step says what was asked, what was found and why it was decided that way, and a
// failure names the first failing step and any other problems found.

export type Phase =
  | 'dns'
  | 'security-group-out'
  | 'nacl-out'
  | 'route'
  | 'nat-gateway'
  | 'internet-gateway'
  | 'nacl-in'
  | 'delivery'

// `no-match`: nothing applied (a route lookup or rule list without a match). `not-evaluated`: the step could not be
// evaluated because an earlier one failed. `not-modelled`: the simulator does not model this yet, so the answer is unknown.
export type Decision = 'allow' | 'deny' | 'no-match' | 'info' | 'not-evaluated' | 'not-modelled'

// Categories to filter on; the text is in the step.
export type Cause =
  | 'dns-resolver-disabled'
  | 'no-route'
  | 'blackhole-route'
  | 'no-public-ip'
  | 'security-group-blocks'
  | 'nacl-blocks'
  | 'nat-gateway-unavailable'
  | 'nat-gateway-private'
  | 'nat-without-internet-route'
  | 'not-modelled'

// A resource or rule that decided, as the console shows it: its id, its Name tag when there is one.
export interface Evidence {
  kind: 'vpc' | 'subnet' | 'route-table' | 'route' | 'security-group' | 'security-group-rule' | 'network-acl' | 'network-acl-entry'
    | 'internet-gateway' | 'nat-gateway' | 'address' | 'dns'
  id: string
  name?: string
  note?: string
}

export interface Step {
  phase: Phase
  decision: Decision
  summary: string
  // What was asked, what was found, why it was decided that way and what else was considered.
  detail: string[]
  evidence: Evidence[]
  cause?: Cause
}

// What the code under test observes for this outcome. A dropped packet gets no answer.
export type Observed = 'reached' | 'connect-timeout' | 'dns-failure' | 'unknown'

// Facts the network layer attaches to the request; the policy engine reads them as condition keys later.
export interface RequestContext {
  sourceIp?: string
  path: 'internet-gateway' | 'nat-gateway' | 'aws-managed'
  natGatewayId?: string
}

export interface Trace {
  from: string
  to: string
  intent: string
  outcome: 'reached' | 'failed' | 'unknown'
  observed: Observed
  steps: Step[]
  // The first failing step in packet order, and the cause of every failing step.
  failedAt?: Phase
  cause?: Cause
  problems: { phase: Phase; cause: Cause; summary: string }[]
  // Present when the call got through.
  context?: RequestContext
  // A suggestion derived from the cause. Facts are in the steps; the hint can be wrong.
  hint?: string
}

const OBSERVED: Record<Observed, string> = {
  reached: 'the call succeeds',
  'connect-timeout': 'a connect timeout (a dropped packet gets no answer, so the client waits for its connect timeout)',
  'dns-failure': 'a name resolution error',
  unknown: 'unknown: part of the path is not modelled',
}

const TAG: Record<Decision, string> = {
  allow: 'allow',
  deny: 'DENY ',
  'no-match': 'none ',
  info: 'info ',
  'not-evaluated': 'skip ',
  'not-modelled': 'n/m  ',
}

const label = (e: Evidence) => `${e.id}${e.name ? ` (${e.name})` : ''}`

export function summarize(steps: Step[]): Pick<Trace, 'outcome' | 'failedAt' | 'cause' | 'problems'> {
  const denied = steps.filter(s => s.decision === 'deny')
  const problems = denied.map(s => ({ phase: s.phase, cause: s.cause!, summary: s.summary }))
  if (denied.length) {
    return { outcome: 'failed', failedAt: denied[0].phase, cause: denied[0].cause, problems }
  }
  const unknown = steps.some(s => s.decision === 'not-modelled')
  return { outcome: unknown ? 'unknown' : 'reached', problems }
}

// The terminal form: one block per step, the cause, and what the code under test would see.
export function renderTrace(trace: Trace): string {
  const head = trace.outcome === 'reached' ? 'REACHED' : trace.outcome === 'unknown' ? 'UNKNOWN (not modelled)' : `FAILED at ${trace.failedAt}`
  const lines = [`${trace.from} -> ${trace.to}   ${head}`, `  ${trace.intent}`]
  trace.steps.forEach((step, index) => {
    lines.push(`  ${index + 1}  ${step.phase.padEnd(18)} [${TAG[step.decision]}] ${step.summary}`)
    for (const line of step.detail) {
      lines.push(`       ${line}`)
    }
    if (step.evidence.length) {
      lines.push(`       evidence: ${step.evidence.map(e => `${e.kind} ${label(e)}${e.note ? ` - ${e.note}` : ''}`).join('; ')}`)
    }
  })
  if (trace.outcome === 'failed') {
    lines.push(`  Cause: ${trace.cause}`)
    if (trace.problems.length > 1) {
      lines.push(`  All problems found: ${trace.problems.map(p => `${p.phase} (${p.cause})`).join(', ')}`)
    }
  }
  if (trace.context) {
    lines.push(`  Request context: source ${trace.context.sourceIp ?? 'unknown'} via ${trace.context.path}${trace.context.natGatewayId ? ` ${trace.context.natGatewayId}` : ''}`)
  }
  if (trace.hint) {
    lines.push(`  Hint: ${trace.hint}`)
  }
  lines.push(`  What the code sees: ${OBSERVED[trace.observed]}`)
  return lines.join('\n')
}
