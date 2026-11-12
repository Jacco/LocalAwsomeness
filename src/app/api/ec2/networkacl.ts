import { isIPv6 } from "net"
import { AwsError } from "../common"
import { canonical, formatCidr, parseCidr } from "../data/ec2/cidr"
import { newId } from "../data/ec2/ids"
import { addNetworkAcl, type Resource } from "../data/ec2/state"
import { QUOTAS, quota } from "../quotas"
import { KINDS, find, invalidValue, tagsFromSpecifications, type Op } from "./request"

// The final deny rule is the highest number; entries are only counted below it.
const MAX_RULE_NUMBER = 32766

// A network ACL entry as the API returns it.
type Entry = Record<string, any>

export const createNetworkAclOp: Op = (state, { scope, params }) => {
  const vpc = find(state.vpcs, params.VpcId, KINDS.vpc)
  if (Object.values(state.networkAcls).filter(acl => acl.VpcId === vpc.VpcId).length >= quota(scope, QUOTAS.networkAclsPerVpc)) {
    throw new AwsError('NetworkAclLimitExceeded', 'The maximum number of network ACLs has been reached.')
  }
  const tags = tagsFromSpecifications(params.TagSpecifications, 'network-acl')
  const acl = addNetworkAcl(state, scope, { vpcId: vpc.VpcId, tags })
  return { NetworkAcl: acl, ClientToken: params.ClientToken }
}

export const deleteNetworkAclOp: Op = (state, { params }) => {
  const acl = find(state.networkAcls, params.NetworkAclId, KINDS.networkAcl)
  if (acl.IsDefault) {
    invalidValue('cannot delete default network acl')
  }
  if (acl.Associations.length) {
    throw new AwsError('DependencyViolation', `The network acl '${acl.NetworkAclId}' has dependencies and cannot be deleted.`)
  }
  delete state.networkAcls[acl.NetworkAclId]
}

const PROTOCOLS: Record<string, string> = { tcp: '6', udp: '17', icmp: '1', icmpv6: '58', '-1': '-1' }

function protocolOf(protocol: string): string {
  const known = PROTOCOLS[protocol.toLowerCase()]
  if (known) {
    return known
  }
  if (/^\d{1,3}$/.test(protocol) && Number(protocol) <= 255) {
    return String(Number(protocol))
  }
  return invalidValue(`Invalid value '${protocol}' for protocol. Unknown protocol.`)
}

function ruleNumberOf(params: Record<string, any>): number {
  const ruleNumber: number = params.RuleNumber
  if (!Number.isInteger(ruleNumber) || ruleNumber < 1 || ruleNumber > MAX_RULE_NUMBER) {
    invalidValue(`Value ( ${ruleNumber} ) for parameter ruleNumber is invalid. Rule number must be between 1 and ${MAX_RULE_NUMBER}.`)
  }
  return ruleNumber
}

function entryOf(params: Record<string, any>): Entry {
  const RuleNumber = ruleNumberOf(params)
  const Protocol = protocolOf(params.Protocol)
  const { CidrBlock, Ipv6CidrBlock } = params
  if ((CidrBlock === undefined) === (Ipv6CidrBlock === undefined)) {
    invalidValue('Exactly one of CidrBlock and Ipv6CidrBlock must be specified')
  }
  let cidr: Record<string, string>
  if (CidrBlock !== undefined) {
    const parsed = parseCidr(CidrBlock)
    if (!parsed) {
      invalidValue(`Invalid value '${CidrBlock}' for cidrBlock. Must be a valid CIDR block.`)
    }
    cidr = { CidrBlock: formatCidr(canonical(parsed)) }
  } else {
    const [address, prefix, ...rest] = Ipv6CidrBlock.split('/')
    if (rest.length || !isIPv6(address) || !/^\d{1,3}$/.test(prefix ?? '') || Number(prefix) > 128) {
      invalidValue(`Invalid value '${Ipv6CidrBlock}' for ipv6CidrBlock. Must be a valid IPv6 CIDR block.`)
    }
    cidr = { Ipv6CidrBlock: Ipv6CidrBlock.toLowerCase() }
  }

  const entry: Entry = { ...cidr, Egress: params.Egress, Protocol, RuleAction: params.RuleAction, RuleNumber }
  // Ports and ICMP types only exist for TCP, UDP and ICMP; other protocols allow or deny every port.
  if (Protocol === '6' || Protocol === '17') {
    const range = params.PortRange
    if (!range || range.From === undefined || range.To === undefined) {
      invalidValue(`Protocol ${Protocol} requires a port range (PortRange From and To).`)
    }
    for (const port of [range.From, range.To]) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        invalidValue(`Invalid value '${port}' for portRange. Must be between 0 and 65535.`)
      }
    }
    if (range.From > range.To) {
      invalidValue(`Invalid value '${range.From}' for portRange. 'From' must not be greater than 'To' ('${range.To}').`)
    }
    entry.PortRange = { From: range.From, To: range.To }
  } else if (Protocol === '1' || Protocol === '58') {
    const icmp = params.IcmpTypeCode
    if (!icmp || icmp.Type === undefined || icmp.Code === undefined) {
      invalidValue('ICMP and ICMPv6 rules require an ICMP type and code (IcmpTypeCode Type and Code).')
    }
    entry.IcmpTypeCode = { Code: icmp.Code, Type: icmp.Type }
  }
  return entry
}

// Egress rules first, each direction by rule number, as the API lists them.
const sortEntries = (acl: Resource) =>
  acl.Entries.sort((a: Entry, b: Entry) => Number(b.Egress) - Number(a.Egress) || a.RuleNumber - b.RuleNumber)

const indexOfEntry = (acl: Resource, ruleNumber: number, egress: boolean) =>
  (acl.Entries as Entry[]).findIndex(entry => entry.RuleNumber === ruleNumber && entry.Egress === egress)

const entryNotFound = (ruleNumber: number) =>
  new AwsError('InvalidNetworkAclEntry.NotFound', `The network acl entry identified by ${ruleNumber} does not exist`)

export const createNetworkAclEntryOp: Op = (state, { scope, params }) => {
  const acl = find(state.networkAcls, params.NetworkAclId, KINDS.networkAcl)
  const entry = entryOf(params)
  if (indexOfEntry(acl, entry.RuleNumber, entry.Egress) >= 0) {
    throw new AwsError('NetworkAclEntryAlreadyExists', `The network acl entry identified by ${entry.RuleNumber} already exists.`)
  }
  const inDirection = (acl.Entries as Entry[]).filter(e => e.Egress === entry.Egress && e.RuleNumber <= MAX_RULE_NUMBER)
  if (inDirection.length >= quota(scope, QUOTAS.rulesPerNetworkAcl)) {
    throw new AwsError('NetworkAclEntryLimitExceeded', "You've reached the limit on the number of rules that you can add to the network ACL.")
  }
  acl.Entries.push(entry)
  sortEntries(acl)
}

export const replaceNetworkAclEntryOp: Op = (state, { params }) => {
  const acl = find(state.networkAcls, params.NetworkAclId, KINDS.networkAcl)
  const entry = entryOf(params)
  const index = indexOfEntry(acl, entry.RuleNumber, entry.Egress)
  if (index < 0) {
    throw entryNotFound(entry.RuleNumber)
  }
  acl.Entries[index] = entry
}

export const deleteNetworkAclEntryOp: Op = (state, { params }) => {
  const acl = find(state.networkAcls, params.NetworkAclId, KINDS.networkAcl)
  const ruleNumber = ruleNumberOf(params)
  const index = indexOfEntry(acl, ruleNumber, params.Egress)
  if (index < 0) {
    throw entryNotFound(ruleNumber)
  }
  acl.Entries.splice(index, 1)
}

// Moves a subnet to another network ACL of the same VPC; the subnet always has exactly one association.
export const replaceNetworkAclAssociationOp: Op = (state, { params }) => {
  const target = find(state.networkAcls, params.NetworkAclId, KINDS.networkAcl)
  const associationId: string = params.AssociationId
  const current = Object.values(state.networkAcls).find(acl =>
    acl.Associations.some((a: { NetworkAclAssociationId: string }) => a.NetworkAclAssociationId === associationId))
  if (!current) {
    throw new AwsError('InvalidAssociationID.NotFound', `The association ID '${associationId}' does not exist`)
  }
  const association = current.Associations.find((a: { NetworkAclAssociationId: string }) => a.NetworkAclAssociationId === associationId)
  if (current.NetworkAclId === target.NetworkAclId) {
    return { NewAssociationId: associationId }
  }
  if (state.subnets[association.SubnetId]?.VpcId !== target.VpcId) {
    invalidValue(`Network ACL ${target.NetworkAclId} and subnet ${association.SubnetId} belong to different networks`)
  }
  current.Associations = current.Associations.filter((a: { NetworkAclAssociationId: string }) => a.NetworkAclAssociationId !== associationId)
  const created = { NetworkAclAssociationId: newId('aclassoc'), NetworkAclId: target.NetworkAclId, SubnetId: association.SubnetId }
  target.Associations.push(created)
  return { NewAssociationId: created.NetworkAclAssociationId }
}
