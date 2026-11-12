import { appendEvents, createGroup, createStream, loadLogs, logGroupArn, logStreamArn, saveLogs } from "../data/logs"
import { accessDenial } from "../policy/authorizer"
import type { LogNetworkDecision } from "../runtime/run"

// Lambda writes the log of an invocation to CloudWatch Logs: log group /aws/lambda/<function>, one stream per execution
// environment (here: one per invocation, every invocation is a cold start). AWS does it with the permissions of the
// *execution role*: without logs:CreateLogGroup (only when the group does not exist yet), logs:CreateLogStream and
// logs:PutLogEvents nothing is written, and neither the caller of Invoke nor the function is told. This module does the
// same and says why, in the invocation record, because "why is there no log?" is a question this app should answer.

interface Scope {
  account: string
  region: string
}

export interface LogDelivery {
  Group: string
  Stream: string
  Status: 'written' | 'not-written'
  // Why not: the denial the role got, as the message of the error.
  Reason?: string
  // Network trace for CloudWatch Logs reachability
  NetworkDecision?: LogNetworkDecision
}

export const logGroupName = (functionName: string) => `/aws/lambda/${functionName}`

const timestampOf = (line: string, start: number, end: number) => (/^(END|REPORT) RequestId: /.test(line) ? end : start)

export function deliverLog(
  scope: Scope, functionName: string, session: string, stream: string, lines: string[], start: number, durationMs: number,
  networkDecision?: LogNetworkDecision,
): LogDelivery {
  const group = logGroupName(functionName)
  const state = loadLogs(scope)
  
  // Check network reachability first
  if (networkDecision && networkDecision.reachable !== 'allow') {
    return { 
      Group: group, 
      Stream: stream, 
      Status: 'not-written', 
      Reason: `Network unreachable: ${networkDecision.reason}`,
      NetworkDecision: networkDecision,
    }
  }
  
  // Then check permissions
  const wanted: [string, string][] = [
    ...(state.groups[group] ? [] : [['logs:CreateLogGroup', logGroupArn(scope, group)] as [string, string]]),
    ['logs:CreateLogStream', logStreamArn(scope, group, stream)],
    ['logs:PutLogEvents', logStreamArn(scope, group, stream)],
  ]
  for (const [action, resource] of wanted) {
    const denied = accessDenial(session, action, resource)
    if (denied) {
      return { 
        Group: group, 
        Stream: stream, 
        Status: 'not-written', 
        Reason: denied.message,
        NetworkDecision: networkDecision,
      }
    }
  }
  const g = state.groups[group] ?? createGroup(state, group, {}, start)
  const s = createStream(g, stream, start)
  const end = start + Math.ceil(durationMs)
  appendEvents(scope, g, s, lines.map(message => ({ timestamp: timestampOf(message, start, end), message })), Date.now())
  saveLogs(scope, state)
  return { 
    Group: group, 
    Stream: stream, 
    Status: 'written',
    NetworkDecision: networkDecision,
  }
}
