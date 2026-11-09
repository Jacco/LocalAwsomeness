import { AwsError, getRequestInfo } from "../common"
import { pseudoId, issueSession } from "../db/credentials"
import * as iam from "../db/iam"
import { QueryHandler, QueryParams, STS_NS, queryError, queryResponse } from "../query"

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

const handlers: Record<string, QueryHandler> = {
  GetCallerIdentity({ account, principal, userId }) {
    return { Arn: principal, UserId: userId, Account: account }
  },

  AssumeRole({ principal, q }) {
    const roleArn = q.required('RoleArn')
    const sessionName = q.required('RoleSessionName')
    if (!/^[\w+=,.@-]{2,64}$/.test(sessionName)) {
      throw new AwsError('ValidationError', `1 validation error detected: Value '${sessionName}' at 'roleSessionName' failed to satisfy constraint: Member must satisfy regular expression pattern: [\\w+=,.@-]*`)
    }
    const m = roleArn.match(/^arn:aws:iam::(\d{12}):role(\/(?:[^/]+\/)*)([\w+=,.@-]+)$/)
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
}

export async function POST(request: Request) {
  const { principalAccount, user, userId } = getRequestInfo(request)
  const q = new QueryParams(await request.text())
  const action = q.action
  try {
    const handler = action && Object.hasOwn(handlers, action) ? handlers[action] : undefined
    if (!handler) {
      throw new AwsError('InvalidAction', `Could not find operation ${action} for version 2011-06-15`)
    }
    return queryResponse(STS_NS, action!, handler({ account: principalAccount, principal: user, userId: userId || pseudoId('AIDA', user), q }))
  } catch (e) {
    return queryError(STS_NS, e)
  }
}
