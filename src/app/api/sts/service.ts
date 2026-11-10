import { AwsError } from "../common"
import { pseudoId, issueSession } from "../db/credentials"
import * as iam from "../db/iam"
import { QueryProtocol } from "../protocols"
import { QueryHandler, STS_NS } from "../query"
import { defineService } from "../registry"

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

const ROLE_ARN = /^arn:aws:iam::(\d{12}):role(\/(?:[^/]+\/)*)([\w+=,.@-]+)$/

const GetCallerIdentity: QueryHandler = ({ account, principal, userId }) =>
  ({ Arn: principal, UserId: userId || pseudoId('AIDA', principal), Account: account })

const AssumeRole: QueryHandler = ({ principal, params: q }) => {
  const roleArn = q.required('RoleArn')
  const sessionName = q.required('RoleSessionName')
  if (!/^[\w+=,.@-]{2,64}$/.test(sessionName)) {
    throw new AwsError('ValidationError', `1 validation error detected: Value '${sessionName}' at 'roleSessionName' failed to satisfy constraint: Member must satisfy regular expression pattern: [\\w+=,.@-]*`)
  }
  const m = roleArn.match(ROLE_ARN)
  if (!m) {
    throw new AwsError('ValidationError', `Invalid RoleArn: ${roleArn}`)
  }
  const [, roleAccount, , roleName] = m
  const denied = new AwsError('AccessDenied', `User: ${principal} is not authorized to perform: sts:AssumeRole on resource: ${roleArn}`, 403)

  const role = iam.findRole(roleAccount, roleName)
  if (!role || role.arn !== roleArn || !iam.trustAllows(role, principal)) {
    throw denied
  }
  const requested = q.optional('DurationSeconds')
  const duration = requested === undefined ? Math.min(3600, role.maxSessionDuration) : Number(requested)
  if (!Number.isInteger(duration) || duration < 900 || duration > 43200) {
    throw new AwsError('ValidationError', `1 validation error detected: Value '${requested}' at 'durationSeconds' failed to satisfy constraint: Member must have value between 900 and 43200`)
  }
  if (duration > role.maxSessionDuration) {
    throw new AwsError('ValidationError', `The requested DurationSeconds exceeds the MaxSessionDuration set for this role.`)
  }

  const assumedArn = `arn:aws:sts::${roleAccount}:assumed-role/${roleName}/${sessionName}`
  const session = issueSession(roleAccount, assumedArn, `${role.roleId}:${sessionName}`, duration)
  return {
    Credentials: {
      AccessKeyId: session.keyId,
      SecretAccessKey: session.secret,
      SessionToken: session.sessionToken,
      Expiration: iso(session.expiration!)
    },
    AssumedRoleUser: { AssumedRoleId: session.userId, Arn: assumedArn },
    PackedPolicySize: 0
  }
}

export const sts = defineService({
  iamPrefix: 'sts',
  protocol: new QueryProtocol(STS_NS, '2011-06-15'),
  operations: {
    GetCallerIdentity,
    AssumeRole: {
      handler: AssumeRole,
      // The role is addressed by ARN in the request; an unparsable ARN is rejected by the handler.
      resources: ({ params }) => [params.optional('RoleArn') ?? '*']
    }
  }
})
