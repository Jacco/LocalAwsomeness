import { AwsError } from "../common"
import { findRole } from "../db/iam"

// What PutBucketPolicy accepts. AWS checks a bucket policy when it is put and answers MalformedPolicy for a structure it
// cannot use, a resource outside the bucket, an action that is not an S3 action, or a principal that does not exist; doing
// the same here makes a typo show up at once instead of as a denial later.

const asList = (value: unknown): unknown[] => (value === undefined ? [] : ([] as unknown[]).concat(value))

const malformed = (message: string) => new AwsError('MalformedPolicy', message, 400)

const ACCOUNT = /^\d{12}$/
const ROOT = /^arn:aws:iam::(\d{12}):root$/
const ROLE = /^arn:aws:iam::(\d{12}):role\/(?:.*\/)?([^/]+)$/
const SESSION = /^arn:aws:sts::(\d{12}):assumed-role\/[^/]+\/[^/]+$/

function validateAwsPrincipal(entry: unknown) {
  if (typeof entry !== 'string') {
    throw malformed('Invalid principal in policy')
  }
  if (entry === '*' || ACCOUNT.test(entry) || ROOT.test(entry) || SESSION.test(entry)) {
    return
  }
  const role = ROLE.exec(entry)
  if (role && findRole(role[1], role[2])) {
    return
  }
  // Also IAM users: the simulator has none, so a user ARN never names an existing principal.
  throw malformed('Invalid principal in policy')
}

function validatePrincipal(element: unknown) {
  if (element === '*') {
    return
  }
  if (typeof element !== 'object' || element === null || Array.isArray(element) || Object.keys(element).length === 0) {
    throw malformed('Invalid principal in policy')
  }
  for (const [type, value] of Object.entries(element)) {
    if (type === 'AWS') {
      asList(value).forEach(validateAwsPrincipal)
    } else if (type === 'CanonicalUser' || type === 'Federated') {
      throw new AwsError('NotImplemented', `Principal type ${type} is not supported by this simulator`, 501)
    } else if (type !== 'Service') {
      throw malformed('Invalid principal in policy')
    }
  }
}

function validateResource(bucket: string, resource: unknown) {
  const arn = `arn:aws:s3:::${bucket}`
  if (typeof resource !== 'string' || (resource !== arn && !resource.startsWith(`${arn}/`))) {
    throw malformed('Policy has invalid resource')
  }
}

function validateAction(action: unknown) {
  if (typeof action !== 'string' || (action !== '*' && !/^s3:[A-Za-z*?]+$/i.test(action))) {
    throw malformed('Policy has invalid action')
  }
}

export function validateBucketPolicy(bucket: string, document: unknown) {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw malformed("Policies must be valid JSON and the first byte must be '{'")
  }
  const policy = document as Record<string, unknown>
  if (policy.Version !== undefined && policy.Version !== '2012-10-17' && policy.Version !== '2008-10-17') {
    throw malformed('The policy must contain a valid version string')
  }
  const statements = asList(policy.Statement)
  if (statements.length === 0) {
    throw malformed('Missing required field Statement')
  }
  for (const item of statements) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw malformed('Missing required field Statement')
    }
    const statement = item as Record<string, unknown>
    if (statement.Effect !== 'Allow' && statement.Effect !== 'Deny') {
      throw malformed(statement.Effect === undefined ? 'Missing required field Effect' : `Invalid effect: ${statement.Effect}`)
    }
    if (!('Principal' in statement) && !('NotPrincipal' in statement)) {
      throw malformed('Missing required field Principal')
    }
    validatePrincipal(statement.Principal ?? statement.NotPrincipal)
    const actions = asList(statement.Action ?? statement.NotAction)
    if (actions.length === 0) {
      throw malformed('Missing required field Action')
    }
    actions.forEach(validateAction)
    const resources = asList(statement.Resource ?? statement.NotResource)
    if (resources.length === 0) {
      throw malformed('Missing required field Resource')
    }
    resources.forEach(resource => validateResource(bucket, resource))
  }
}
