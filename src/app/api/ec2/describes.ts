import { AwsError } from "../common"
import { availableAddressCount } from "../data/ec2/interfaces"
import type { Resource } from "../data/ec2/state"
import { effectiveRouteState } from "../../analysis/network/routes"
import { describe } from "./describe"
import { KINDS, type Op } from "./request"
import { ipPermissions, securityGroupView } from "./securitygroup"

export const describeRouteTablesOp: Op = (state, { params }) => {
  const routes = (rt: any) => rt.Routes as Record<string, any>[]
  const associations = (rt: any) => rt.Associations as Record<string, any>[]
  // The state of a route follows its target (a route to a deleted NAT gateway is a blackhole), so it is derived here.
  const withState = (rt: any): Resource => ({ ...rt, Routes: routes(rt).map(r => ({ ...r, State: effectiveRouteState(state, rt.VpcId, r as Resource) })) })
  const { items, nextToken } = describe({
    items: Object.values(state.routeTables).map(withState),
    idOf: rt => rt.RouteTableId,
    ids: params.RouteTableIds,
    kind: KINDS.routeTable,
    filters: params.Filters,
    maxResults: params.MaxResults,
    nextToken: params.NextToken,
    filterFns: {
      'association.gateway-id': rt => associations(rt).map(a => a.GatewayId),
      'association.route-table-association-id': rt => associations(rt).map(a => a.RouteTableAssociationId),
      'association.route-table-id': rt => associations(rt).map(a => a.RouteTableId),
      'association.subnet-id': rt => associations(rt).map(a => a.SubnetId),
      'association.main': rt => associations(rt).map(a => Boolean(a.Main)),
      'owner-id': rt => rt.OwnerId,
      'route-table-id': rt => rt.RouteTableId,
      'route.destination-cidr-block': rt => routes(rt).map(r => r.DestinationCidrBlock),
      'route.destination-ipv6-cidr-block': rt => routes(rt).map(r => r.DestinationIpv6CidrBlock),
      'route.destination-prefix-list-id': rt => routes(rt).map(r => r.DestinationPrefixListId),
      'route.egress-only-internet-gateway-id': rt => routes(rt).map(r => r.EgressOnlyInternetGatewayId),
      'route.gateway-id': rt => routes(rt).map(r => r.GatewayId),
      'route.instance-id': rt => routes(rt).map(r => r.InstanceId),
      'route.nat-gateway-id': rt => routes(rt).map(r => r.NatGatewayId),
      'route.transit-gateway-id': rt => routes(rt).map(r => r.TransitGatewayId),
      'route.origin': rt => routes(rt).map(r => r.Origin),
      'route.state': rt => routes(rt).map(r => r.State),
      'route.vpc-peering-connection-id': rt => routes(rt).map(r => r.VpcPeeringConnectionId),
      'vpc-id': rt => rt.VpcId,
    },
  })
  return { RouteTables: items, NextToken: nextToken }
}

export const describeNetworkAclsOp: Op = (state, { params }) => {
  const entries = (acl: any) => acl.Entries as Record<string, any>[]
  const associations = (acl: any) => acl.Associations as Record<string, any>[]
  const { items, nextToken } = describe({
    items: Object.values(state.networkAcls),
    idOf: acl => acl.NetworkAclId,
    ids: params.NetworkAclIds,
    kind: KINDS.networkAcl,
    filters: params.Filters,
    maxResults: params.MaxResults,
    nextToken: params.NextToken,
    filterFns: {
      'association.association-id': acl => associations(acl).map(a => a.NetworkAclAssociationId),
      'association.network-acl-id': acl => associations(acl).map(a => a.NetworkAclId),
      'association.subnet-id': acl => associations(acl).map(a => a.SubnetId),
      default: acl => acl.IsDefault,
      'entry.cidr': acl => entries(acl).map(e => e.CidrBlock),
      'entry.icmp.code': acl => entries(acl).map(e => e.IcmpTypeCode?.Code),
      'entry.icmp.type': acl => entries(acl).map(e => e.IcmpTypeCode?.Type),
      'entry.ipv6-cidr': acl => entries(acl).map(e => e.Ipv6CidrBlock),
      'entry.port-range.from': acl => entries(acl).map(e => e.PortRange?.From),
      'entry.port-range.to': acl => entries(acl).map(e => e.PortRange?.To),
      'entry.protocol': acl => entries(acl).map(e => e.Protocol),
      'entry.rule-action': acl => entries(acl).map(e => e.RuleAction),
      'entry.egress': acl => entries(acl).map(e => e.Egress),
      'entry.rule-number': acl => entries(acl).map(e => e.RuleNumber),
      'network-acl-id': acl => acl.NetworkAclId,
      'owner-id': acl => acl.OwnerId,
      'vpc-id': acl => acl.VpcId,
    },
  })
  return { NetworkAcls: items, NextToken: nextToken }
}

export const describeSecurityGroupsOp: Op = (state, { params }) => {
  const permissions = (group: any, egress: boolean) => ipPermissions(state, group.GroupId, egress) as Record<string, any>[]
  const perm = (egress: boolean, pick: (p: Record<string, any>) => unknown[]) =>
    (group: any) => permissions(group, egress).flatMap(pick)
  const permissionFilters = (prefix: string, egress: boolean) => ({
    [`${prefix}.cidr`]: perm(egress, p => p.IpRanges.map((r: any) => r.CidrIp)),
    [`${prefix}.from-port`]: perm(egress, p => [p.FromPort]),
    [`${prefix}.group-id`]: perm(egress, p => p.UserIdGroupPairs.map((g: any) => g.GroupId)),
    [`${prefix}.group-name`]: perm(egress, () => []),
    [`${prefix}.ipv6-cidr`]: perm(egress, p => p.Ipv6Ranges.map((r: any) => r.CidrIpv6)),
    [`${prefix}.prefix-list-id`]: perm(egress, p => p.PrefixListIds.map((r: any) => r.PrefixListId)),
    [`${prefix}.protocol`]: perm(egress, p => [p.IpProtocol]),
    [`${prefix}.to-port`]: perm(egress, p => [p.ToPort]),
    [`${prefix}.user-id`]: perm(egress, p => p.UserIdGroupPairs.map((g: any) => g.UserId)),
  })

  let groups = Object.values(state.securityGroups)
  const names: string[] | undefined = params.GroupNames
  if (names?.length) {
    const missing = names.filter(name => !groups.some(g => g.GroupName === name))
    if (missing.length) {
      throw new AwsError('InvalidGroup.NotFound', `The security group '${missing[0]}' does not exist`)
    }
    groups = groups.filter(g => names.includes(g.GroupName))
  }
  const { items, nextToken } = describe({
    items: groups,
    idOf: g => g.GroupId,
    ids: params.GroupIds,
    kind: KINDS.securityGroup,
    filters: params.Filters,
    maxResults: params.MaxResults,
    nextToken: params.NextToken,
    filterFns: {
      description: g => g.Description,
      'group-id': g => g.GroupId,
      'group-name': g => g.GroupName,
      'owner-id': g => g.OwnerId,
      'vpc-id': g => g.VpcId,
      ...permissionFilters('ip-permission', false),
      ...permissionFilters('egress.ip-permission', true),
    },
  })
  return { SecurityGroups: items.map(g => securityGroupView(state, g)), NextToken: nextToken }
}

export const describeInternetGatewaysOp: Op = (state, { params }) => {
  const attachments = (igw: any) => igw.Attachments as Record<string, any>[]
  const { items, nextToken } = describe({
    items: Object.values(state.internetGateways),
    idOf: igw => igw.InternetGatewayId,
    ids: params.InternetGatewayIds,
    kind: KINDS.internetGateway,
    filters: params.Filters,
    maxResults: params.MaxResults,
    nextToken: params.NextToken,
    filterFns: {
      'attachment.state': igw => attachments(igw).map(a => a.State),
      'attachment.vpc-id': igw => attachments(igw).map(a => a.VpcId),
      'internet-gateway-id': igw => igw.InternetGatewayId,
      'owner-id': igw => igw.OwnerId,
    },
  })
  return { InternetGateways: items, NextToken: nextToken }
}

export const describeDhcpOptionsOp: Op = (state, { params }) => {
  const configurations = (o: any) => o.DhcpConfigurations as { Key: string; Values: { Value: string }[] }[]
  const { items, nextToken } = describe({
    items: Object.values(state.dhcpOptions),
    idOf: o => o.DhcpOptionsId,
    ids: params.DhcpOptionsIds,
    kind: KINDS.dhcpOptions,
    filters: params.Filters,
    maxResults: params.MaxResults,
    nextToken: params.NextToken,
    filterFns: {
      'dhcp-options-id': o => o.DhcpOptionsId,
      key: o => configurations(o).map(c => c.Key),
      value: o => configurations(o).flatMap(c => c.Values.map(v => v.Value)),
      'owner-id': o => o.OwnerId,
    },
  })
  return { DhcpOptions: items, NextToken: nextToken }
}

export const describeNetworkInterfacesOp: Op = (state, { params }) => {
  const addresses = (eni: any) => (eni.PrivateIpAddresses ?? []) as Record<string, any>[]
  const { items, nextToken } = describe({
    items: Object.values(state.networkInterfaces),
    idOf: eni => eni.NetworkInterfaceId,
    ids: params.NetworkInterfaceIds,
    kind: KINDS.networkInterface,
    filters: params.Filters,
    maxResults: params.MaxResults,
    nextToken: params.NextToken,
    filterFns: {
      'addresses.association.owner-id': eni => addresses(eni).map(a => a.Association?.IpOwnerId),
      'addresses.association.public-ip': eni => addresses(eni).map(a => a.Association?.PublicIp),
      'addresses.primary': eni => addresses(eni).map(a => a.Primary),
      'addresses.private-ip-address': eni => addresses(eni).map(a => a.PrivateIpAddress),
      'association.allocation-id': eni => eni.Association?.AllocationId,
      'association.association-id': eni => eni.Association?.AssociationId,
      'association.ip-owner-id': eni => eni.Association?.IpOwnerId,
      'association.public-ip': eni => eni.Association?.PublicIp,
      'association.public-dns-name': eni => eni.Association?.PublicDnsName,
      'attachment.attach-time': eni => eni.Attachment?.AttachTime,
      'attachment.attachment-id': eni => eni.Attachment?.AttachmentId,
      'attachment.delete-on-termination': eni => eni.Attachment?.DeleteOnTermination,
      'attachment.device-index': eni => eni.Attachment?.DeviceIndex,
      'attachment.instance-id': eni => eni.Attachment?.InstanceId,
      'attachment.instance-owner-id': eni => eni.Attachment?.InstanceOwnerId,
      'attachment.status': eni => eni.Attachment?.Status,
      'availability-zone': eni => eni.AvailabilityZone,
      'availability-zone-id': eni => eni.AvailabilityZoneId,
      description: eni => eni.Description,
      'group-id': eni => (eni.Groups ?? []).map((g: any) => g.GroupId),
      'ipv6-addresses.ipv6-address': eni => (eni.Ipv6Addresses ?? []).map((a: any) => a.Ipv6Address),
      'interface-type': eni => eni.InterfaceType,
      'mac-address': eni => eni.MacAddress,
      'network-interface-id': eni => eni.NetworkInterfaceId,
      'operator.managed': eni => eni.Operator?.Managed,
      'operator.principal': eni => eni.Operator?.Principal,
      'owner-id': eni => eni.OwnerId,
      'private-dns-name': eni => eni.PrivateDnsName,
      'private-ip-address': eni => eni.PrivateIpAddress,
      'requester-id': eni => eni.RequesterId,
      'requester-managed': eni => eni.RequesterManaged,
      'source-dest-check': eni => eni.SourceDestCheck,
      status: eni => eni.Status,
      'subnet-id': eni => eni.SubnetId,
      'vpc-id': eni => eni.VpcId,
    },
  })
  return { NetworkInterfaces: items.map(({ Tags, ...eni }) => ({ ...eni, TagSet: Tags })), NextToken: nextToken }
}
