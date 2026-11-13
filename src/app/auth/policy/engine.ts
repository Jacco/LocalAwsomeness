import type { PolicyDocument } from "../../api/data/reference"
import { matchPrincipal, type PrincipalMatch } from "./principal"

// Policy evaluation, the parts of the IAM evaluation logic the simulator models: identity-based policies (what a role may do)
// and resource-based policies (who may use a resource). In each, an explicit deny wins, otherwise an allow is needed,
// otherwise the request is denied implicitly. How the two combine is in authorizer.ts. Pure functions;
// src/app/api/policy/policy.md says what is not evaluated yet.

export interface IdentityPolicy {
  // Where the statements come from, for the explanation: `inline policy "p1" of role r`, `AWS managed policy arn:...`.
  source: string
  document: PolicyDocument
}

export interface StatementResult {
  source: string
  sid?: string
  effect: 'Allow' | 'Deny'
  // Whether the action and the resource of the request match the statement, and if not, what did not.
  applies: boolean
  why: string
}

export interface Evaluation {
  action: string
  resource: string
  decision: 'allow' | 'explicit-deny' | 'implicit-deny'
  // The statement that decided: the first explicit deny, else the first allow.
  decidedBy?: StatementResult
  statements: StatementResult[]
}

// Something the evaluation cannot answer yet (a Condition, a policy variable). It is raised instead of guessing, because an
// ignored condition makes an allow too wide and a deny too narrow.
export class PolicyNotModelled extends Error {}

const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&')

// IAM wildcards: `*` for any run of characters, `?` for one.
export function wildcardMatch(pattern: string, text: string, ignoreCase = false): boolean {
  const regex = new RegExp(`^${escape(pattern).replace(/\*/g, '.*').replace(/\?/g, '.')}$`, ignoreCase ? 'is' : 's')
  return regex.test(text)
}

// Condition keys the caller of the evaluation knows the value of for this request (iam:PassedToService for iam:PassRole).
// A statement whose Condition uses any other key, or an operator not listed below, is not evaluated (PolicyNotModelled).
export type ConditionContext = Record<string, string | string[]>

const STRING_OPERATORS: Record<string, { like: boolean; negated: boolean }> = {
  StringEquals: { like: false, negated: false },
  StringNotEquals: { like: false, negated: true },
  StringLike: { like: true, negated: false },
  StringNotLike: { like: true, negated: true },
}

const asList = (value: unknown): string[] => (value === undefined ? [] : ([] as string[]).concat(value as string[]))

function statementsOf(document: PolicyDocument): Record<string, any>[] {
  const statements = document.Statement
  return statements === undefined ? [] : ([] as Record<string, any>[]).concat(statements)
}

function matches(statement: Record<string, any>, action: string, resource: string): { applies: boolean; why: string } {
  const negatedAction = 'NotAction' in statement
  const actions = asList(negatedAction ? statement.NotAction : statement.Action)
  const actionMatches = actions.some(p => wildcardMatch(p, action, true)) !== negatedAction
  if (!actionMatches) {
    return { applies: false, why: `${negatedAction ? 'NotAction' : 'Action'} ${actions.join(', ') || '(none)'} ${negatedAction ? 'excludes' : 'does not match'} ${action}` }
  }
  const negatedResource = 'NotResource' in statement
  const resources = asList(negatedResource ? statement.NotResource : statement.Resource)
  const variable = resources.find(p => p.includes('${'))
  if (variable) {
    throw new PolicyNotModelled(`a statement uses a policy variable in its Resource (${variable}), which is not evaluated yet`)
  }
  const resourceMatches = resources.some(p => wildcardMatch(p, resource)) !== negatedResource
  if (!resourceMatches) {
    return { applies: false, why: `${negatedResource ? 'NotResource' : 'Resource'} ${resources.join(', ') || '(none)'} ${negatedResource ? 'excludes' : 'does not match'} ${resource}` }
  }
  return { applies: true, why: `action ${action} and resource ${resource} match` }
}

function statementLabel(statement: { Sid?: string }, effect: string, source: string) {
  return `${statement.Sid ? `statement "${statement.Sid}"` : `a ${effect} statement`} of ${source}`
}

// Whether the Condition block holds: every operator and every key in it must. A key is matched case-insensitively and
// against any of the request's values; for the Not operators, none of the policy values may match.
function conditionHolds(statement: Record<string, any>, effect: string, source: string, context: ConditionContext): { holds: boolean; why: string } {
  const failed: string[] = []
  for (const [operator, entries] of Object.entries(statement.Condition as Record<string, Record<string, unknown>>)) {
    const kind = STRING_OPERATORS[operator]
    if (!kind) {
      throw conditionNotModelled(statement, effect, source)
    }
    for (const [key, expected] of Object.entries(entries ?? {})) {
      const contextKey = Object.keys(context).find(k => k.toLowerCase() === key.toLowerCase())
      if (contextKey === undefined) {
        throw conditionNotModelled(statement, effect, source)
      }
      const actual = asList(context[contextKey])
      const patterns = asList(expected)
      const anyMatch = actual.some(value => patterns.some(p => kind.like ? wildcardMatch(p, value) : p === value))
      if (anyMatch === kind.negated) {
        failed.push(`${operator} ${key} ${patterns.join(', ')} (request: ${actual.join(', ') || 'none'})`)
      }
    }
  }
  return failed.length
    ? { holds: false, why: `Condition does not hold: ${failed.join('; ')}` }
    : { holds: true, why: 'condition holds' }
}

// Matches the action and resource, then the Condition. Without a context, any Condition is not evaluated.
function applies(statement: Record<string, any>, effect: string, source: string, action: string, resource: string, context?: ConditionContext) {
  const result = matches(statement, action, resource)
  if (!result.applies || statement.Condition === undefined) {
    return result
  }
  if (!context) {
    throw conditionNotModelled(statement, effect, source)
  }
  const condition = conditionHolds(statement, effect, source, context)
  return condition.holds ? { applies: true, why: `${result.why}, ${condition.why}` } : { applies: false, why: condition.why }
}

export function evaluateIdentityPolicies(policies: IdentityPolicy[], action: string, resource: string, context?: ConditionContext): Evaluation {
  const results: StatementResult[] = []
  for (const policy of policies) {
    for (const statement of statementsOf(policy.document)) {
      const effect = statement.Effect === 'Deny' ? 'Deny' : 'Allow'
      const result = applies(statement, effect, policy.source, action, resource, context)
      results.push({ source: policy.source, sid: statement.Sid, effect, applies: result.applies, why: result.why })
    }
  }
  return decide(action, resource, results)
}

function conditionNotModelled(statement: { Sid?: string; Condition?: object }, effect: string, source: string) {
  return new PolicyNotModelled(`${statementLabel(statement, effect, source)} has a Condition (${Object.keys(statement.Condition ?? {}).join(', ')}), which is not evaluated yet`)
}

function decide<R extends StatementResult>(action: string, resource: string, results: R[], preferred?: (r: R) => boolean) {
  const denied = results.find(r => r.applies && r.effect === 'Deny')
  if (denied) {
    return { action, resource, decision: 'explicit-deny' as const, decidedBy: denied, statements: results }
  }
  const allows = results.filter(r => r.applies && r.effect === 'Allow')
  const allowed = allows.find(r => preferred?.(r)) ?? allows[0]
  return { action, resource, decision: allowed ? 'allow' as const : 'implicit-deny' as const, decidedBy: allowed, statements: results }
}

// A resource-based policy (a bucket policy): the statements also have to name the principal of the request.
export interface ResourceStatementResult extends StatementResult {
  principal?: PrincipalMatch
}

export interface ResourceEvaluation extends Evaluation {
  decidedBy?: ResourceStatementResult
  statements: ResourceStatementResult[]
}

export function evaluateResourcePolicy(policy: IdentityPolicy, principal: string, action: string, resource: string, context?: ConditionContext): ResourceEvaluation {
  const results: ResourceStatementResult[] = []
  for (const statement of statementsOf(policy.document)) {
    const effect = statement.Effect === 'Deny' ? 'Deny' : 'Allow'
    if ('NotPrincipal' in statement) {
      throw new PolicyNotModelled(`${statement.Sid ? `statement "${statement.Sid}"` : `a ${effect} statement`} of ${policy.source} uses NotPrincipal, which is not evaluated yet`)
    }
    const named = matchPrincipal(statement.Principal, principal)
    if (!named) {
      results.push({ source: policy.source, sid: statement.Sid, effect, applies: false, why: `Principal ${JSON.stringify(statement.Principal)} does not name ${principal}` })
      continue
    }
    const result = applies(statement, effect, policy.source, action, resource, context)
    results.push({ source: policy.source, sid: statement.Sid, effect, applies: result.applies, why: result.why, principal: named })
  }
  // An allow that names the principal itself (or everyone) decides over one that names its account: only the first grants
  // access on its own within the account (see authorizer.ts).
  return decide(action, resource, results, r => r.principal !== 'account')
}
