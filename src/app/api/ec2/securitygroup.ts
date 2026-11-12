import { isIPv6 } from "net"
import { AwsError } from "../common"
import { canonical, formatCidr, parseCidr } from "../data/ec2/cidr"
import { addSecurityGroup, defaultVpc, securityGroupRule, type Ec2State, type Resource, type Scope } from "../data/ec2/state"
import { QUOTAS, quota } from "../quotas"
import { describe } from "./describe"
import { KINDS, find, invalidValue, missing, tagsFromSpecifications, type Op } from "./request"

// The API returns security group rules grouped into IpPermissions (one per protocol and port range); the
// state keeps them as individual rules with their own IDs.
export function ipPermissions(state: Ec2State, groupId: string, egress: boolean): Record<string, unknown>[] {
  return groupPermissions(Object.values(state.securityGroupRules).filter(rule => rule.GroupId === groupId && rule.IsEgress === egress))
}

export function groupPermissions(rules: Record<string, any>[]): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, any>>()
  for (const rule of rules) {
    const all = rule.IpProtocol === '-1'
    const key = `${rule.IpProtocol}/${all ? '' : `${rule.FromPort}-${rule.ToPort}`}`
    let permission = groups.get(key)
    if (!permission) {
      permission = {
        IpProtocol: rule.IpProtocol,
        ...(all ? {} : { FromPort: rule.FromPort, ToPort: rule.ToPort }),
        IpRanges: [],
        Ipv6Ranges: [],
        PrefixListIds: [],
        UserIdGroupPairs: [],
      }
      groups.set(key, permission)
    }
    const description = rule.Description === undefined ? {} : { Description: rule.Description }
    if (rule.CidrIpv4) {
      permission.IpRanges.push({ CidrIp: rule.CidrIpv4, ...description })
    } else if (rule.CidrIpv6) {
      permission.Ipv6Ranges.push({ CidrIpv6: rule.CidrIpv6, ...description })
    } else if (rule.PrefixListId) {
      permission.PrefixListIds.push({ PrefixListId: rule.PrefixListId, ...description })
    } else if (rule.ReferencedGroupInfo) {
      permission.UserIdGroupPairs.push({ GroupId: rule.ReferencedGroupInfo.GroupId, UserId: rule.ReferencedGroupInfo.UserId, ...description })
    }
  }
  return [...groups.values()]
}

export function securityGroupView(state: Ec2State, group: Resource): Resource {
  return {
    ...group,
    IpPermissions: ipPermissions(state, group.GroupId, false),
    IpPermissionsEgress: ipPermissions(state, group.GroupId, true),
  }
}

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

const TEXT = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]*$/

function validateText(what: string, value: string, max: number) {
  if (value.length > max) {
    invalidValue(`Value (${value}) for parameter ${what} is invalid. Length exceeds maximum of ${max}.`)
  }
  if (!TEXT.test(value)) {
    invalidValue(`Value (${value}) for parameter ${what} is invalid. Character sets beyond ASCII are not supported.`)
  }
}

export const createSecurityGroupOp: Op = (state, { scope, params }) => {
  const name: string = params.GroupName
  const description: string = params.Description
  let vpcId: string = params.VpcId
  if (vpcId === undefined) {
    const vpc = defaultVpc(state)
    if (!vpc) {
      throw new AwsError('VPCIdNotSpecified', 'No default VPC for this user. GroupName is only supported for EC2-Classic and default VPC.')
    }
    vpcId = vpc.VpcId
  } else {
    find(state.vpcs, vpcId, KINDS.vpc)
  }
  validateText('GroupName', name, 255)
  validateText('GroupDescription', description, 255)
  if (name.length === 0 || description.length === 0) {
    invalidValue(`Invalid value '' for ${name.length === 0 ? 'GroupName' : 'GroupDescription'}. Cannot be empty.`)
  }
  if (name.startsWith('sg-')) {
    invalidValue('Group names may not be in the format sg-*')
  }
  if (name === 'default') {
    throw new AwsError('InvalidGroup.Reserved', "The name 'default' is reserved")
  }
  if (Object.values(state.securityGroups).some(g => g.VpcId === vpcId && g.GroupName === name)) {
    throw new AwsError('InvalidGroup.Duplicate', `The security group '${name}' already exists for VPC '${vpcId}'`)
  }
  if (Object.keys(state.securityGroups).length >= quota(scope, QUOTAS.securityGroupsPerRegion)) {
    throw new AwsError('SecurityGroupLimitExceeded', 'The maximum number of security groups has been reached.')
  }
  const tags = tagsFromSpecifications(params.TagSpecifications, 'security-group')
  const group = addSecurityGroup(state, scope, { vpcId, name, description, tags })
  // Every new group allows all outbound traffic until that rule is revoked.
  const egress = securityGroupRule(scope, group.GroupId, true, { CidrIpv4: '0.0.0.0/0' })
  state.securityGroupRules[egress.SecurityGroupRuleId] = egress
  return { GroupId: group.GroupId, Tags: group.Tags, SecurityGroupArn: group.SecurityGroupArn }
}

// A group is addressed by ID, or by name in the default VPC.
function groupOf(state: Ec2State, params: { GroupId?: string; GroupName?: string }): Resource {
  if (params.GroupId !== undefined) {
    return find(state.securityGroups, params.GroupId, KINDS.securityGroup)
  }
  if (params.GroupName === undefined) {
    throw new AwsError('MissingParameter', 'Either GroupName or GroupId must be specified')
  }
  const vpc = defaultVpc(state)
  const group = vpc && Object.values(state.securityGroups).find(g => g.VpcId === vpc.VpcId && g.GroupName === params.GroupName)
  if (!group) {
    throw new AwsError('InvalidGroup.NotFound', vpc
      ? `The security group '${params.GroupName}' does not exist in default VPC '${vpc.VpcId}'`
      : `The security group '${params.GroupName}' does not exist`)
  }
  return group
}

export const deleteSecurityGroupOp: Op = (state, { params }) => {
  const group = groupOf(state, params)
  if (group.GroupName === 'default') {
    throw new AwsError('CannotDelete', `the specified group: "${group.GroupId}" name: "default" cannot be deleted by a user`)
  }
  // A rule of the group itself that refers to the group does not keep it alive.
  const referenced = Object.values(state.securityGroupRules).some(rule =>
    rule.ReferencedGroupInfo?.GroupId === group.GroupId && rule.GroupId !== group.GroupId)
  const attached = Object.values(state.networkInterfaces).some(eni => (eni.Groups ?? []).some((g: { GroupId: string }) => g.GroupId === group.GroupId))
  if (referenced || attached) {
    throw new AwsError('DependencyViolation', `resource ${group.GroupId} has a dependent object`)
  }
  for (const rule of Object.values(state.securityGroupRules)) {
    if (rule.GroupId === group.GroupId) {
      delete state.securityGroupRules[rule.SecurityGroupRuleId]
    }
  }
  delete state.securityGroups[group.GroupId]
  return { Return: true, GroupId: group.GroupId }
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

// What identifies a rule apart from its ID: protocol, ports and exactly one source or destination.
interface RuleSpec {
  IpProtocol: string
  FromPort: number
  ToPort: number
  CidrIpv4?: string
  CidrIpv6?: string
  PrefixListId?: string
  ReferencedGroupInfo?: { GroupId: string; UserId: string }
  Description?: string
}

const PROTOCOLS: Record<string, string> = {
  tcp: 'tcp', udp: 'udp', icmp: 'icmp', icmpv6: 'icmpv6', '-1': '-1', '6': 'tcp', '17': 'udp', '1': 'icmp', '58': 'icmpv6',
}

function normalizeProtocol(protocol: string): string {
  const known = PROTOCOLS[protocol.toLowerCase()]
  if (known) {
    return known
  }
  if (/^\d{1,3}$/.test(protocol) && Number(protocol) <= 255) {
    return String(Number(protocol))
  }
  return invalidValue(`Invalid value '${protocol}' for IP protocol. Unknown protocol.`)
}

// TCP and UDP take a port range, ICMP takes a type (from) and code (to); other protocols have no ports.
function portsOf(protocol: string, from: number | undefined, to: number | undefined): { FromPort: number; ToPort: number } {
  if (protocol === 'tcp' || protocol === 'udp') {
    if (from === undefined || to === undefined) {
      invalidValue(`Invalid value 'null' for portRange. Must specify both from and to ports with ${protocol.toUpperCase()}.`)
    }
    for (const port of [from, to]) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        invalidValue(`Invalid value '${port}' for portRange. Must be between 0 and 65535.`)
      }
    }
    if (from > to) {
      invalidValue(`Invalid value '${from}' for portRange. 'from' must not be greater than 'to' ('${to}').`)
    }
    return { FromPort: from, ToPort: to }
  }
  if (protocol === 'icmp' || protocol === 'icmpv6') {
    if (from === undefined || to === undefined) {
      invalidValue(`Invalid value 'null' for ICMP type or code. Must specify both type and code with ${protocol.toUpperCase()}.`)
    }
    for (const value of [from, to]) {
      if (!Number.isInteger(value) || value < -1 || value > 255) {
        invalidValue(`Invalid value '${value}' for ICMP type or code. Must be between -1 and 255.`)
      }
    }
    return { FromPort: from, ToPort: to }
  }
  return { FromPort: -1, ToPort: -1 }
}

const malformedRule = (message: string) => new AwsError('InvalidPermission.Malformed', message)

function cidrV4(text: string): string {
  const cidr = parseCidr(text)
  if (!cidr) {
    throw malformedRule(`Invalid CIDR address: ${text}`)
  }
  return formatCidr(canonical(cidr))
}

function cidrV6(text: string): string {
  const [address, prefix, ...rest] = text.split('/')
  if (rest.length || !isIPv6(address) || !/^\d{1,3}$/.test(prefix ?? '') || Number(prefix) > 128) {
    throw malformedRule(`Invalid CIDR address: ${text}`)
  }
  return text.toLowerCase()
}

// Security groups can only be referenced from the same VPC (peering is not implemented).
function referencedGroup(state: Ec2State, scope: Scope, group: Resource, pair: { GroupId?: string; GroupName?: string; UserId?: string }) {
  let referenced: Resource | undefined
  if (pair.GroupId !== undefined) {
    referenced = find(state.securityGroups, pair.GroupId, KINDS.securityGroup)
  } else if (pair.GroupName !== undefined) {
    referenced = Object.values(state.securityGroups).find(g => g.VpcId === group.VpcId && g.GroupName === pair.GroupName)
    if (!referenced) {
      throw new AwsError('InvalidGroup.NotFound', `The security group '${pair.GroupName}' does not exist in VPC '${group.VpcId}'`)
    }
  } else {
    throw malformedRule('A security group reference must specify GroupId or GroupName')
  }
  if (referenced.VpcId !== group.VpcId || (pair.UserId !== undefined && pair.UserId !== scope.account)) {
    throw new AwsError('InvalidGroup.NotFound', `The security group '${pair.GroupId ?? pair.GroupName}' does not exist`)
  }
  return { GroupId: referenced.GroupId, UserId: scope.account }
}

function noSource(): never {
  throw malformedRule('A rule must specify exactly one source or destination: an IPv4 or IPv6 range, a prefix list or a security group')
}

function withDescription(description: string | undefined): Pick<RuleSpec, 'Description'> {
  if (description === undefined) {
    return {}
  }
  validateText('description', description, 255)
  return { Description: description }
}

function prefixList(id: string): string {
  // Prefix lists (managed ones for AWS services, customer-owned ones) are not implemented, so none can exist.
  throw new AwsError('InvalidPrefixListID.NotFound', `The prefix list ID '${id}' does not exist`)
}

// One IpPermission holds several sources; each becomes its own rule.
function specsOf(state: Ec2State, scope: Scope, group: Resource, permission: Record<string, any>): RuleSpec[] {
  if (permission.IpProtocol === undefined) {
    missing('IpProtocol')
  }
  const protocol = normalizeProtocol(permission.IpProtocol)
  const base = { IpProtocol: protocol, ...portsOf(protocol, permission.FromPort, permission.ToPort) }
  const specs: RuleSpec[] = [
    ...(permission.IpRanges ?? []).map((r: any) => ({ ...base, CidrIpv4: cidrV4(r.CidrIp), ...withDescription(r.Description) })),
    ...(permission.Ipv6Ranges ?? []).map((r: any) => ({ ...base, CidrIpv6: cidrV6(r.CidrIpv6), ...withDescription(r.Description) })),
    ...(permission.PrefixListIds ?? []).map((r: any) => ({ ...base, PrefixListId: prefixList(r.PrefixListId), ...withDescription(r.Description) })),
    ...(permission.UserIdGroupPairs ?? []).map((p: any) =>
      ({ ...base, ReferencedGroupInfo: referencedGroup(state, scope, group, p), ...withDescription(p.Description) })),
  ]
  return specs.length ? specs : noSource()
}

const FLAT_PARAMETERS = ['IpProtocol', 'FromPort', 'ToPort', 'CidrIp', 'SourceSecurityGroupName', 'SourceSecurityGroupOwnerId']

// The operations accept either IpPermissions or the single-rule shorthand parameters.
function permissionsOf(params: Record<string, any>): Record<string, any>[] {
  const flat = FLAT_PARAMETERS.filter(name => params[name] !== undefined)
  if (params.IpPermissions?.length) {
    if (flat.length) {
      throw new AwsError('InvalidParameterCombination', `The parameter IpPermissions cannot be used with the parameter ${flat[0]}`)
    }
    return params.IpPermissions
  }
  if (!flat.length) {
    missing('IpPermissions')
  }
  return [{
    IpProtocol: params.IpProtocol,
    FromPort: params.FromPort,
    ToPort: params.ToPort,
    IpRanges: params.CidrIp === undefined ? [] : [{ CidrIp: params.CidrIp }],
    UserIdGroupPairs: params.SourceSecurityGroupName === undefined
      ? []
      : [{ GroupName: params.SourceSecurityGroupName, UserId: params.SourceSecurityGroupOwnerId }],
  }]
}

const rulesOf = (state: Ec2State, group: Resource, egress: boolean) =>
  Object.values(state.securityGroupRules).filter(rule => rule.GroupId === group.GroupId && rule.IsEgress === egress)

// Works on both specs and stored rules, which share these members.
const sameRule = (a: Record<string, any>, b: Record<string, any>) =>
  a.IpProtocol === b.IpProtocol && a.FromPort === b.FromPort && a.ToPort === b.ToPort
  && a.CidrIpv4 === b.CidrIpv4 && a.CidrIpv6 === b.CidrIpv6 && a.PrefixListId === b.PrefixListId
  && a.ReferencedGroupInfo?.GroupId === b.ReferencedGroupInfo?.GroupId

function label(spec: RuleSpec): string {
  const peer = spec.CidrIpv4 ?? spec.CidrIpv6 ?? spec.PrefixListId ?? spec.ReferencedGroupInfo?.GroupId
  const protocol = spec.IpProtocol === '-1' ? 'ALL' : spec.IpProtocol.toUpperCase()
  const ports = ['tcp', 'udp', 'icmp', 'icmpv6'].includes(spec.IpProtocol) ? `, from port: ${spec.FromPort}, to port: ${spec.ToPort}` : ''
  return `peer: ${peer}, ${protocol}${ports}, ALLOW`
}

const duplicate = (spec: Record<string, any>) =>
  new AwsError('InvalidPermission.Duplicate', `The specified rule "${label(spec as RuleSpec)}" already exists`)

const notFound = () => new AwsError('InvalidPermission.NotFound', 'The specified rule does not exist in this security group')

const authorize = (egress: boolean): Op => (state, { scope, params }) => {
  const group = groupOf(state, params)
  const specs = permissionsOf(params).flatMap(permission => specsOf(state, scope, group, permission))
  const tags = tagsFromSpecifications(params.TagSpecifications, 'security-group-rule')
  const existing = rulesOf(state, group, egress)
  const created: Resource[] = []
  for (const spec of specs) {
    if ([...existing, ...created].some(rule => sameRule(rule, spec))) {
      throw duplicate(spec)
    }
    created.push(securityGroupRule(scope, group.GroupId, egress, { ...spec, Tags: tags.map(tag => ({ ...tag })) }))
  }
  // The quota is enforced separately per direction and per IP family; a reference to a security group counts as one IPv4 rule here (not verified).
  const family = (rule: Record<string, any>) => (rule.CidrIpv6 ? 'ipv6' : 'ipv4')
  const limit = quota(scope, QUOTAS.rulesPerSecurityGroup)
  for (const kind of ['ipv4', 'ipv6']) {
    if ([...existing, ...created].filter(rule => family(rule) === kind).length > limit) {
      throw new AwsError('RulesPerSecurityGroupLimitExceeded', 'The maximum number of rules per security group has been reached.')
    }
  }
  for (const rule of created) {
    state.securityGroupRules[rule.SecurityGroupRuleId] = rule
  }
  return { Return: true, SecurityGroupRules: created }
}

export const authorizeSecurityGroupIngressOp = authorize(false)
export const authorizeSecurityGroupEgressOp = authorize(true)

// A rule given by ID must belong to the group (and direction) of the request.
function ruleById(state: Ec2State, rules: Resource[], id: string): Resource {
  find(state.securityGroupRules, id, KINDS.securityGroupRule)
  const rule = rules.find(r => r.SecurityGroupRuleId === id)
  if (!rule) {
    throw new AwsError('InvalidSecurityGroupRuleId.NotFound', `The security group rule ID '${id}' does not exist`)
  }
  return rule
}

const revokedView = (rule: Resource) => ({
  SecurityGroupRuleId: rule.SecurityGroupRuleId,
  GroupId: rule.GroupId,
  IsEgress: rule.IsEgress,
  IpProtocol: rule.IpProtocol,
  FromPort: rule.FromPort,
  ToPort: rule.ToPort,
  CidrIpv4: rule.CidrIpv4,
  CidrIpv6: rule.CidrIpv6,
  PrefixListId: rule.PrefixListId,
  ReferencedGroupId: rule.ReferencedGroupInfo?.GroupId,
  Description: rule.Description,
})

const revoke = (egress: boolean): Op => (state, { scope, params }) => {
  const group = groupOf(state, params)
  const rules = rulesOf(state, group, egress)
  const revoked = new Map<string, Resource>()
  const unknown: RuleSpec[] = []
  if (params.SecurityGroupRuleIds?.length) {
    if (params.IpPermissions?.length || FLAT_PARAMETERS.some(name => params[name] !== undefined)) {
      throw new AwsError('InvalidParameterCombination', 'The parameter SecurityGroupRuleIds cannot be used with IpPermissions or the single rule parameters')
    }
    for (const id of params.SecurityGroupRuleIds as string[]) {
      revoked.set(id, ruleById(state, rules, id))
    }
  } else {
    for (const permission of permissionsOf(params)) {
      for (const spec of specsOf(state, scope, group, permission)) {
        const rule = rules.find(r => sameRule(r, spec))
        if (rule) {
          revoked.set(rule.SecurityGroupRuleId, rule)
        } else {
          unknown.push(spec)
        }
      }
    }
    // In a VPC that is not the default one, a rule that does not exist fails the whole request.
    if (unknown.length && !state.vpcs[group.VpcId]?.IsDefault) {
      throw notFound()
    }
  }
  for (const id of revoked.keys()) {
    delete state.securityGroupRules[id]
  }
  return {
    Return: true,
    UnknownIpPermissions: groupPermissions(unknown),
    RevokedSecurityGroupRules: [...revoked.values()].map(revokedView),
  }
}

export const revokeSecurityGroupIngressOp = revoke(false)
export const revokeSecurityGroupEgressOp = revoke(true)

export const modifySecurityGroupRulesOp: Op = (state, { scope, params }) => {
  const group = groupOf(state, params)
  const changes = new Map<string, Resource>()
  for (const { SecurityGroupRuleId: id, SecurityGroupRule: request } of params.SecurityGroupRules as Record<string, any>[]) {
    const old = ruleById(state, Object.values(state.securityGroupRules).filter(rule => rule.GroupId === group.GroupId), id)
    if (!request) {
      missing('SecurityGroupRules.SecurityGroupRule')
    }
    const protocol = normalizeProtocol(request.IpProtocol ?? missing('SecurityGroupRule.IpProtocol'))
    const sources = [request.CidrIpv4, request.CidrIpv6, request.PrefixListId, request.ReferencedGroupId].filter(source => source !== undefined)
    if (sources.length !== 1) {
      noSource()
    }
    const { Tags, SecurityGroupRuleId, SecurityGroupRuleArn, GroupId, GroupOwnerId, IsEgress } = old
    changes.set(id, {
      SecurityGroupRuleId, SecurityGroupRuleArn, GroupId, GroupOwnerId, IsEgress, Tags,
      IpProtocol: protocol,
      ...portsOf(protocol, request.FromPort, request.ToPort),
      ...(request.CidrIpv4 === undefined ? {} : { CidrIpv4: cidrV4(request.CidrIpv4) }),
      ...(request.CidrIpv6 === undefined ? {} : { CidrIpv6: cidrV6(request.CidrIpv6) }),
      ...(request.PrefixListId === undefined ? {} : { PrefixListId: prefixList(request.PrefixListId) }),
      ...(request.ReferencedGroupId === undefined ? {} : { ReferencedGroupInfo: referencedGroup(state, scope, group, { GroupId: request.ReferencedGroupId }) }),
      ...withDescription(request.Description),
    })
  }
  // The result must not contain two equal rules in a direction.
  const after = Object.values(state.securityGroupRules)
    .filter(rule => rule.GroupId === group.GroupId)
    .map(rule => changes.get(rule.SecurityGroupRuleId) ?? rule)
  for (const rule of changes.values()) {
    if (after.some(other => other !== rule && other.IsEgress === rule.IsEgress && sameRule(other, rule))) {
      throw duplicate(rule)
    }
  }
  for (const [id, rule] of changes) {
    state.securityGroupRules[id] = rule as Resource
  }
  return { Return: true }
}

const updateDescriptions = (egress: boolean): Op => (state, { scope, params }) => {
  const group = groupOf(state, params)
  const rules = rulesOf(state, group, egress)
  const updates: [Resource, string | undefined][] = []
  if (params.SecurityGroupRuleDescriptions?.length) {
    for (const { SecurityGroupRuleId: id, Description } of params.SecurityGroupRuleDescriptions as Record<string, any>[]) {
      updates.push([ruleById(state, rules, id), withDescription(Description).Description])
    }
  } else {
    if (!params.IpPermissions?.length) {
      missing('IpPermissions')
    }
    for (const permission of params.IpPermissions as Record<string, any>[]) {
      for (const spec of specsOf(state, scope, group, permission)) {
        const rule = rules.find(r => sameRule(r, spec))
        if (!rule) {
          throw notFound()
        }
        updates.push([rule, spec.Description])
      }
    }
  }
  // An omitted description removes the existing one.
  for (const [rule, description] of updates) {
    if (description === undefined) {
      delete rule.Description
    } else {
      rule.Description = description
    }
  }
  return { Return: true }
}

export const updateSecurityGroupRuleDescriptionsIngressOp = updateDescriptions(false)
export const updateSecurityGroupRuleDescriptionsEgressOp = updateDescriptions(true)

export const describeSecurityGroupRulesOp: Op = (state, { params }) => {
  const { items, nextToken } = describe({
    items: Object.values(state.securityGroupRules),
    idOf: rule => rule.SecurityGroupRuleId,
    ids: params.SecurityGroupRuleIds,
    kind: KINDS.securityGroupRule,
    filters: params.Filters,
    maxResults: params.MaxResults,
    nextToken: params.NextToken,
    filterFns: {
      'group-id': rule => rule.GroupId,
      'security-group-rule-id': rule => rule.SecurityGroupRuleId,
    },
  })
  return { SecurityGroupRules: items, NextToken: nextToken }
}
