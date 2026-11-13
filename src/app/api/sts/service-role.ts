import { logCloudTrailEvent } from '../cloudtrail/cloudtrail'
import { issueSession } from '../data/credentials'
import * as iam from '../data/iam'

const ROLE_ARN = /^arn:aws:iam::(\d{12}):role\/(?:[^/]+\/)*([\w+=,.@-]+)$/

export interface ServiceSession {
  // arn:aws:sts::<account>:assumed-role/<role>/<session>
  principal: string
  session: ReturnType<typeof issueSession>
}

// An AWS service (cloudformation.amazonaws.com, lambda.amazonaws.com) assuming a role on behalf of the account: the
// counterpart of the sts:AssumeRole a service makes in AWS. The role's trust policy must name the service; that is the
// whole authorization. Either way the attempt is recorded in the CloudTrail of the role's account, as AWS does.
// Undefined when the role does not exist or does not trust the service; the caller answers with its own error.
export function assumeRoleAsService(service: string, roleArn: string, sessionName: string, region: string, durationSeconds = 3600): ServiceSession | undefined {
  const m = roleArn.match(ROLE_ARN)
  const account = m?.[1]
  const role = m ? iam.findRole(m[1], m[2]) : undefined
  const trusted = role !== undefined && role.arn === roleArn && iam.trustsService(role, service)

  const event = {
    timestamp: new Date().toISOString(),
    principal: service,
    service: 'sts',
    action: 'AssumeRole',
    resource: roleArn,
    account: account ?? 'unknown',
    region,
    parameters: { roleArn, roleSessionName: sessionName, durationSeconds, invokedBy: service },
  }
  if (!trusted) {
    if (account) {
      logCloudTrailEvent({
        ...event,
        authorizationDecision: 'deny',
        authorizationReason: role ? `The trust policy of ${roleArn} does not allow ${service} to assume it` : `No role ${roleArn}`,
        errorCode: 'AccessDenied',
      })
    }
    return undefined
  }
  const principal = `arn:aws:sts::${account}:assumed-role/${role.roleName}/${sessionName}`
  const session = issueSession(account!, principal, `${role.roleId}:${sessionName}`, durationSeconds)
  logCloudTrailEvent({ ...event, authorizationDecision: 'allow' })
  return { principal, session }
}
