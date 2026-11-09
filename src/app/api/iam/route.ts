import { AwsError, getRequestInfo } from "../common";
import { IAM_NS, QueryParams, queryError, queryResponse } from "../query";
import { listUsers } from "./listUsers";
import { policyHandlers } from "./policies";
import { roleHandlers } from "./roles";

const handlers = { ...roleHandlers, ...policyHandlers }

export async function POST(request: Request) {
  const { principalAccount, user, userId } = getRequestInfo(request)
  const q = new QueryParams(await request.text())
  const action = q.action
  try {
    // TODO Version Prefix MaxItem and also Marker
    if (action === 'ListUsers') return listUsers()
    const handler = action && Object.hasOwn(handlers, action) ? handlers[action] : undefined
    if (!handler) {
      throw new AwsError('InvalidAction', `Could not find operation ${action} for version 2010-05-08`)
    }
    return queryResponse(IAM_NS, action!, handler({ account: principalAccount, principal: user, userId, q }))
  } catch (e) {
    return queryError(IAM_NS, e)
  }
}
