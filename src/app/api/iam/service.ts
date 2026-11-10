import { QueryProtocol } from "../protocols"
import { IAM_NS } from "../query"
import { defineService } from "../registry"
import { policyHandlers } from "./policies"
import { roleHandlers } from "./roles"
import { userHandlers } from "./users"

// TODO Version Prefix MaxItem and also Marker
export const iam = defineService({
  iamPrefix: 'iam',
  protocol: new QueryProtocol(IAM_NS, '2010-05-08'),
  operations: { ...roleHandlers, ...policyHandlers, ...userHandlers }
})
