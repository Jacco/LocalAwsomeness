import { AwsError } from "../common"
import * as iam from "../db/iam"
import { findManagedPolicy, type ManagedPolicy } from "../db/reference"
import type { QueryHandler } from "../query"

function policyView(p: ManagedPolicy, counts: Record<string, number>) {
  return {
    PolicyName: p.name,
    PolicyId: p.policyId,
    Arn: p.arn,
    Path: p.path,
    DefaultVersionId: p.defaultVersion,
    AttachmentCount: counts[p.arn] ?? 0,
    PermissionsBoundaryUsageCount: 0,
    IsAttachable: true,
    Description: p.description
  }
}

function requirePolicy(arn: string): ManagedPolicy {
  const policy = findManagedPolicy(arn)
  if (!policy) {
    throw new AwsError('NoSuchEntity', `Policy ${arn} was not found.`, 404)
  }
  return policy
}

export const policyHandlers: Record<string, QueryHandler> = {
  ListPolicies({ account, q }) {
    const scope = q.optional('Scope') ?? iam.PolicyScope.All
    if (!Object.values<string>(iam.PolicyScope).includes(scope)) {
      throw new AwsError('ValidationError', `1 validation error detected: Value '${scope}' at 'scope' failed to satisfy constraint: Member must satisfy enum value set: [All, AWS, Local]`)
    }
    const counts = iam.attachmentCounts(account)
    const onlyAttached = q.optional('OnlyAttached') === 'true'
    const policies = iam.listPolicies(account, scope as iam.PolicyScope, q.optional('PathPrefix'))
      .filter(p => !onlyAttached || counts[p.arn])
    return { Policies: { member: policies.map(p => policyView(p, counts)) }, IsTruncated: false }
  },
  GetPolicy({ account, q }) {
    return { Policy: policyView(requirePolicy(q.required('PolicyArn')), iam.attachmentCounts(account)) }
  },
  GetPolicyVersion({ q }) {
    const arn = q.required('PolicyArn')
    const versionId = q.required('VersionId')
    const policy = requirePolicy(arn)
    const document = policy.documents[versionId]
    if (!document) {
      throw new AwsError('NoSuchEntity', `Policy version ${versionId} of ${arn} was not found.`, 404)
    }
    return {
      PolicyVersion: {
        Document: encodeURIComponent(JSON.stringify(document)),
        VersionId: versionId,
        IsDefaultVersion: versionId === policy.defaultVersion
      }
    }
  }
}
