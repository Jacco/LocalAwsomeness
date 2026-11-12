import { AwsError } from "../common"
import * as org from '../data/organizations'
import type { OrgState } from '../data/organizations'

import type { RequestContext } from "../registry"

type Handler = (ctx: RequestContext) => unknown

// ---------------------------------------------------------------------------
// request helpers
// ---------------------------------------------------------------------------

function invalid(message: string): never {
  throw new AwsError('InvalidInputException', message)
}

function required(body: any, name: string, min = 1, max = 4096): string {
  const value = body?.[name]
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    invalid(`You provided a value that does not match the required pattern or length for ${name}.`)
  }
  return value
}

function optional(body: any, name: string, max = 4096): string | undefined {
  return body?.[name] === undefined ? undefined : required(body, name, 0, max)
}

function paginate<T>(items: T[], body: any, key: string): Record<string, unknown> {
  const max = body?.MaxResults ?? 20
  if (!Number.isInteger(max) || max < 1 || max > 20) {
    invalid('You provided an invalid value for MaxResults. It must be between 1 and 20.')
  }
  let start = 0
  if (body?.NextToken !== undefined) {
    start = Number(Buffer.from(String(body.NextToken), 'base64').toString())
    if (!Number.isInteger(start) || start < 0) {
      invalid('You specified an invalid value for NextToken.')
    }
  }
  const page = items.slice(start, start + max)
  const result: Record<string, unknown> = { [key]: page }
  if (start + max < items.length) {
    result.NextToken = Buffer.from(String(start + max)).toString('base64')
  }
  return result
}

const seconds = (ms?: number) => (ms === undefined ? undefined : ms / 1000)

function validateEmail(email: string) {
  const [local, domain, ...rest] = email.split('@')
  const ok = email.length >= 6 && email.length <= 64
    && /^[\x00-\x7F]+$/.test(email)
    && domain !== undefined && rest.length === 0
    && !/[\s"'()<>[\]:;,\\|%&]/.test(local)
    && !local.startsWith('.')
    && /^[A-Za-z0-9.-]+$/.test(domain)
    && domain.includes('.')
    && !/^[-.]|[-.]$/.test(domain)
  if (!ok) {
    invalid(`The Email "${email}" is not a valid email address.`)
  }
}

function requireParent(o: OrgState, parentId: string) {
  const type = org.targetType(o, parentId)
  if (type !== 'ROOT' && type !== 'ORGANIZATIONAL_UNIT') {
    throw new AwsError('ParentNotFoundException', "We can't find a root or OU with the ParentId that you specified.")
  }
}

// ---------------------------------------------------------------------------
// response shaping
// ---------------------------------------------------------------------------

const arn = (o: OrgState, kind: string, id: string) =>
  `arn:aws:organizations::${o.managementAccountId}:${kind}/${o.id}/${id}`

function organizationView(o: OrgState) {
  const master = org.getAccount(o.managementAccountId)
  return {
    Arn: `arn:aws:organizations::${o.managementAccountId}:organization/${o.id}`,
    Id: o.id,
    FeatureSet: o.featureSet,
    MasterAccountArn: arn(o, 'account', o.managementAccountId),
    MasterAccountEmail: master.email,
    MasterAccountId: o.managementAccountId,
    AvailablePolicyTypes: o.policyTypes.map(Type => ({ Type, Status: 'ENABLED' }))
  }
}

function rootView(o: OrgState) {
  return {
    Id: o.rootId,
    Arn: arn(o, 'root', o.rootId),
    Name: 'Root',
    PolicyTypes: o.policyTypes.map(Type => ({ Type, Status: 'ENABLED' }))
  }
}

function ouView(o: OrgState, ou: org.OrgUnit) {
  return { Id: ou.id, Arn: arn(o, 'ou', ou.id), Name: ou.name }
}

function accountView(o: OrgState, id: string) {
  const member = org.assertMember(o, id)
  const record = org.getAccount(id)
  return {
    Id: id,
    Arn: arn(o, 'account', id),
    Email: record.email,
    Name: record.name,
    State: member.state,
    Status: member.state === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED',
    JoinedMethod: member.joinedMethod,
    JoinedTimestamp: seconds(member.joinedTimestamp)
  }
}

function policySummary(o: OrgState, p: org.Policy) {
  const type = p.type.toLowerCase()
  return {
    Id: p.id,
    Arn: p.awsManaged
      ? `arn:aws:organizations::aws:policy/${type}/${p.id}`
      : `arn:aws:organizations::${o.managementAccountId}:policy/${o.id}/${type}/${p.id}`,
    Name: p.name,
    Description: p.description,
    Type: p.type,
    AwsManaged: p.awsManaged
  }
}

function policyView(o: OrgState, p: org.Policy) {
  return { PolicySummary: policySummary(o, p), Content: JSON.stringify(p.content) }
}

function requestStatusView(r: org.CreateAccountRequest) {
  return {
    Id: r.id,
    AccountId: r.accountId,
    AccountName: r.accountName,
    State: r.state,
    FailureReason: r.failureReason,
    RequestedTimestamp: seconds(r.requestedTimestamp),
    CompletedTimestamp: seconds(r.completedTimestamp)
  }
}

// ---------------------------------------------------------------------------
// handlers (all but CreateOrganization/DescribeOrganization require the management account)
// ---------------------------------------------------------------------------

export const handlers: Record<string, Handler> = {
  // Organization
  CreateOrganization({ account, params: body }) {
    const o = org.createOrganization(account, optional(body, 'FeatureSet'))
    return { Organization: organizationView(o) }
  },
  DescribeOrganization({ account }) {
    return { Organization: organizationView(org.requireOrg(account)) }
  },
  DeleteOrganization({ account }) {
    org.deleteOrganization(org.requireManagement(account))
    return {}
  },
  ListRoots({ account, params: body }) {
    const o = org.requireManagement(account)
    return paginate([rootView(o)], body, 'Roots')
  },
  EnablePolicyType({ account, params: body }) {
    const o = org.requireManagement(account)
    org.enablePolicyType(o, required(body, 'RootId'), required(body, 'PolicyType'))
    return { Root: rootView(o) }
  },
  DisablePolicyType({ account, params: body }) {
    const o = org.requireManagement(account)
    org.disablePolicyType(o, required(body, 'RootId'), required(body, 'PolicyType'))
    return { Root: rootView(o) }
  },

  // Organizational units
  CreateOrganizationalUnit({ account, params: body }) {
    const o = org.requireManagement(account)
    const ou = org.createOrganizationalUnit(o, required(body, 'ParentId'), required(body, 'Name', 1, 128))
    return { OrganizationalUnit: ouView(o, ou) }
  },
  DescribeOrganizationalUnit({ account, params: body }) {
    const o = org.requireManagement(account)
    return { OrganizationalUnit: ouView(o, org.getOrganizationalUnit(o, required(body, 'OrganizationalUnitId'))) }
  },
  UpdateOrganizationalUnit({ account, params: body }) {
    const o = org.requireManagement(account)
    const ou = org.updateOrganizationalUnit(o, required(body, 'OrganizationalUnitId'), required(body, 'Name', 1, 128))
    return { OrganizationalUnit: ouView(o, ou) }
  },
  DeleteOrganizationalUnit({ account, params: body }) {
    org.deleteOrganizationalUnit(org.requireManagement(account), required(body, 'OrganizationalUnitId'))
    return {}
  },
  ListOrganizationalUnitsForParent({ account, params: body }) {
    const o = org.requireManagement(account)
    const parentId = required(body, 'ParentId')
    requireParent(o, parentId)
    return paginate(org.childrenOf(o, parentId).ous.map(ou => ouView(o, ou)), body, 'OrganizationalUnits')
  },
  ListParents({ account, params: body }) {
    const o = org.requireManagement(account)
    const parent = org.parentOf(o, required(body, 'ChildId'))
    return paginate([{ Id: parent.id, Type: parent.type }], body, 'Parents')
  },
  ListChildren({ account, params: body }) {
    const o = org.requireManagement(account)
    const parentId = required(body, 'ParentId')
    const childType = required(body, 'ChildType')
    requireParent(o, parentId)
    const children = org.childrenOf(o, parentId)
    if (childType === 'ACCOUNT') {
      return paginate(children.accounts.map(Id => ({ Id, Type: 'ACCOUNT' })), body, 'Children')
    }
    if (childType === 'ORGANIZATIONAL_UNIT') {
      return paginate(children.ous.map(ou => ({ Id: ou.id, Type: 'ORGANIZATIONAL_UNIT' })), body, 'Children')
    }
    invalid(`You specified an invalid value for ChildType: ${childType}`)
  },

  // Accounts
  CreateAccount({ account, params: body }) {
    const o = org.requireManagement(account)
    const name = required(body, 'AccountName', 1, 50)
    if (!/^[\u0020-\u007E]+$/.test(name)) {
      invalid(`The AccountName "${name}" has character that are not allowed`)
    }
    const email = required(body, 'Email', 6, 64)
    validateEmail(email)
    const roleName = optional(body, 'RoleName', 64)
    if (roleName !== undefined && !/^[\w+=,.@-]{1,64}$/.test(roleName)) {
      invalid(`The RoleName "${roleName}" is not valid.`)
    }
    return { CreateAccountStatus: requestStatusView(org.createAccountRequest(o, name, email, roleName)) }
  },
  DescribeCreateAccountStatus({ account, params: body }) {
    const o = org.requireManagement(account)
    return { CreateAccountStatus: requestStatusView(org.getCreateAccountRequest(o, required(body, 'CreateAccountRequestId'))) }
  },
  ListCreateAccountStatus({ account, params: body }) {
    const o = org.requireManagement(account)
    const states: string[] | undefined = body?.States
    const requests = Object.values(o.createAccountRequests)
      .filter(r => !states || states.includes(r.state))
      .map(requestStatusView)
    return paginate(requests, body, 'CreateAccountStatuses')
  },
  DescribeAccount({ account, params: body }) {
    const o = org.requireManagement(account)
    return { Account: accountView(o, required(body, 'AccountId')) }
  },
  ListAccounts({ account, params: body }) {
    const o = org.requireManagement(account)
    return paginate(Object.keys(o.members).map(id => accountView(o, id)), body, 'Accounts')
  },
  ListAccountsForParent({ account, params: body }) {
    const o = org.requireManagement(account)
    const parentId = required(body, 'ParentId')
    requireParent(o, parentId)
    return paginate(org.childrenOf(o, parentId).accounts.map(id => accountView(o, id)), body, 'Accounts')
  },
  MoveAccount({ account, params: body }) {
    org.moveAccount(
      org.requireManagement(account),
      required(body, 'AccountId'),
      required(body, 'SourceParentId'),
      required(body, 'DestinationParentId')
    )
    return {}
  },
  CloseAccount({ account, params: body }) {
    org.closeAccount(org.requireManagement(account), required(body, 'AccountId'))
    return {}
  },

  // Policies
  CreatePolicy({ account, params: body }) {
    const o = org.requireManagement(account)
    const policy = org.createPolicy(
      o,
      required(body, 'Name', 1, 128),
      required(body, 'Description', 0, 512),
      required(body, 'Type'),
      required(body, 'Content', 1, 1000000)
    )
    return { Policy: policyView(o, policy) }
  },
  DescribePolicy({ account, params: body }) {
    const o = org.requireManagement(account)
    return { Policy: policyView(o, org.getPolicy(o, required(body, 'PolicyId'))) }
  },
  UpdatePolicy({ account, params: body }) {
    const o = org.requireManagement(account)
    const policy = org.updatePolicy(o, required(body, 'PolicyId'), {
      name: optional(body, 'Name', 128),
      description: optional(body, 'Description', 512),
      content: optional(body, 'Content', 1000000)
    })
    return { Policy: policyView(o, policy) }
  },
  DeletePolicy({ account, params: body }) {
    org.deletePolicy(org.requireManagement(account), required(body, 'PolicyId'))
    return {}
  },
  ListPolicies({ account, params: body }) {
    const o = org.requireManagement(account)
    const policies = org.listPolicies(o, required(body, 'Filter'))
    return paginate(policies.map(p => policySummary(o, p)), body, 'Policies')
  },
  AttachPolicy({ account, params: body }) {
    org.attachPolicy(org.requireManagement(account), required(body, 'PolicyId'), required(body, 'TargetId'))
    return {}
  },
  DetachPolicy({ account, params: body }) {
    org.detachPolicy(org.requireManagement(account), required(body, 'PolicyId'), required(body, 'TargetId'))
    return {}
  },
  ListPoliciesForTarget({ account, params: body }) {
    const o = org.requireManagement(account)
    const policies = org.policiesForTarget(o, required(body, 'TargetId'), required(body, 'Filter'))
    return paginate(policies.map(p => policySummary(o, p)), body, 'Policies')
  },
  ListTargetsForPolicy({ account, params: body }) {
    const o = org.requireManagement(account)
    const targets = org.targetsForPolicy(o, required(body, 'PolicyId')).map(t => ({
      TargetId: t.id,
      Name: t.name,
      Type: t.type,
      Arn: arn(o, t.type === 'ROOT' ? 'root' : t.type === 'ORGANIZATIONAL_UNIT' ? 'ou' : 'account', t.id)
    }))
    return paginate(targets, body, 'Targets')
  }
}
