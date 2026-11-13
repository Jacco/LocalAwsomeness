import { AwsError } from '../common'
import { issueSession } from '../data/credentials'
import { assumeRoleAsService } from '../sts/service-role'
import * as iam from '../data/iam'
import { accessDenial } from '../../auth/policy/authorizer'
import { logCloudTrailEvent } from '../cloudtrail/cloudtrail'
import type { RequestContext } from '../registry'

export const CLOUDFORMATION_SERVICE = 'cloudformation.amazonaws.com'
// The session name CloudFormation uses when it assumes a stack's service role (as seen in CloudTrail).
export const SESSION_NAME = 'AWSCloudFormation'
const SESSION_SECONDS = 3600

const ROLE_ARN = /^arn:aws:iam::(\d{12}):role\/(?:[^/]+\/)*([\w+=,.@-]+)$/

function cannotAssume(roleArn: string) {
  return new AwsError('ValidationError', `Role ${roleArn} is invalid or cannot be assumed`)
}

function parseRoleArn(roleArn: string) {
  const m = roleArn.match(ROLE_ARN)
  if (!m) {
    throw new AwsError('ValidationError', `1 validation error detected: Value '${roleArn}' at 'roleARN' failed to satisfy constraint: Member must satisfy regular expression pattern: arn:.+:iam::[0-9]{12}:role/.+`)
  }
  return m
}

// The role a RoleARN names, if CloudFormation may assume it: it exists and its trust policy names the service.
function assumableRole(roleArn: string) {
  const m = parseRoleArn(roleArn)
  const role = iam.findRole(m[1], m[2])
  if (!role || role.arn !== roleArn || !iam.trustsService(role, CLOUDFORMATION_SERVICE)) {
    throw cannotAssume(roleArn)
  }
  return { account: m[1], name: m[2], role }
}

// Handing CloudFormation a service role (RoleARN on CreateStack/DeleteStack/...) is an implicit iam:PassRole by the caller,
// with iam:PassedToService = cloudformation.amazonaws.com; then the role must be one CloudFormation can assume.
// AWS does not record PassRole in CloudTrail; the simulator does, marked `simulated`, so a failing PassRole can be traced.
export function checkPassRole(ctx: RequestContext, roleArn: string): void {
  parseRoleArn(roleArn)
  const denied = accessDenial(ctx.principal, 'iam:PassRole', roleArn, undefined, { 'iam:PassedToService': CLOUDFORMATION_SERVICE })
  logCloudTrailEvent({
    timestamp: new Date().toISOString(),
    principal: ctx.principal,
    service: 'iam',
    action: 'PassRole',
    resource: roleArn,
    account: ctx.account,
    region: ctx.region,
    parameters: { roleArn, passedToService: CLOUDFORMATION_SERVICE, invokedBy: CLOUDFORMATION_SERVICE },
    simulated: true,
    ...(denied
      ? { authorizationDecision: 'deny' as const, authorizationReason: denied.message, errorCode: denied.type }
      : { authorizationDecision: 'allow' as const }),
  })
  if (denied) {
    throw denied
  }
  assumableRole(roleArn)
}

export interface DeploymentSession {
  // Who the deployment acts as: the assumed service role, or the caller.
  principal: string
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration?: number }
}

// The credentials the deployment engine makes its API calls with, so every call is authorized like any other request.
// With a service role, CloudFormation assumes it (trust is checked again: the role may have changed since it was passed),
// which is recorded in CloudTrail as an sts:AssumeRole by cloudformation.amazonaws.com. Without one, CloudFormation acts
// with the permissions of the caller of the stack operation (in AWS a forward access session, not an AssumeRole).
export function deploymentSession(caller: { principal: string; userId: string; account: string; region: string }, roleArn?: string): DeploymentSession {
  if (roleArn) {
    parseRoleArn(roleArn)
    const assumed = assumeRoleAsService(CLOUDFORMATION_SERVICE, roleArn, SESSION_NAME, caller.region, SESSION_SECONDS)
    if (!assumed) {
      throw cannotAssume(roleArn)
    }
    return { principal: assumed.principal, credentials: toCredentials(assumed.session) }
  }
  const session = issueSession(caller.account, caller.principal, caller.userId, SESSION_SECONDS)
  return { principal: caller.principal, credentials: toCredentials(session) }
}

function toCredentials(session: { keyId: string; secret: string; sessionToken?: string; expiration?: number }) {
  return {
    accessKeyId: session.keyId,
    secretAccessKey: session.secret,
    sessionToken: session.sessionToken ?? '',
    expiration: session.expiration,
  }
}
