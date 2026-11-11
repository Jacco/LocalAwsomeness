// Matching the Principal element of resource-based policies (S3 bucket policies, KMS key policies) against the principal a
// request is made as. Pure functions.

const ASSUMED_ROLE = /^arn:aws:sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/
const ROLE = /^arn:aws:iam::(\d{12}):role\/(?:.*\/)?([^/]+)$/
const ACCOUNT_OF = /^arn:aws:(?:iam|sts)::(\d{12}):/

// How a statement names the principal: by itself (its ARN, or its role for a session), by its account (the account id or
// arn:aws:iam::<account>:root, which delegates to the identity-based policies of that account), or as everyone ("*").
export type PrincipalMatch = 'principal' | 'account' | 'everyone'

export function accountOf(principal: string): string | undefined {
  return ACCOUNT_OF.exec(principal)?.[1]
}

const roleOf = (arn: string): [string, string] | undefined => {
  const m = ASSUMED_ROLE.exec(arn) ?? ROLE.exec(arn)
  return m ? [m[1], m[2]] : undefined
}

// Whether a principal ARN in a policy names this identity: the same ARN, or a role whose sessions this principal is.
export function namesPrincipal(entry: string, principal: string): boolean {
  if (entry === principal) {
    return true
  }
  const named = ROLE.exec(entry)
  const actual = roleOf(principal)
  return !!named && !!actual && named[1] === actual[0] && named[2] === actual[1]
}

const asList = (value: unknown): string[] => (value === undefined ? [] : ([] as string[]).concat(value as string[]))

// Only AWS principals are compared: requests are made as IAM identities, never as a service or a federated user.
export function matchPrincipal(element: unknown, principal: string): PrincipalMatch | undefined {
  if (element === '*') {
    return 'everyone'
  }
  if (typeof element !== 'object' || element === null) {
    return undefined
  }
  const entries = asList((element as Record<string, unknown>).AWS)
  if (entries.includes('*')) {
    return 'everyone'
  }
  if (entries.some(entry => namesPrincipal(entry, principal))) {
    return 'principal'
  }
  const account = accountOf(principal)
  if (account && entries.some(entry => entry === account || entry === `arn:aws:iam::${account}:root`)) {
    return 'account'
  }
  return undefined
}
