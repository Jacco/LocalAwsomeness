import { AwsError } from "../common"
import { newId, newResourceId } from "../db/ec2/ids"
import type { Ec2State, Resource } from "../db/ec2/state"
import { natGatewayIsLive } from "./natgateway"
import { KINDS, find, invalidValue, tagsFromSpecifications, type Op } from "./request"

// A route can only point at a NAT gateway that exists and has not been deleted. (Whether it is in the same VPC as the
// route table is not checked yet.)
function assertNatGateway(state: Ec2State, id: string | undefined) {
  if (id !== undefined && !(state.natGateways[id] && natGatewayIsLive(state.natGateways[id]))) {
    throw new AwsError('InvalidNatGatewayID.NotFound', `The natGateway ID '${id}' does not exist`)
  }
}

export const createRouteTableOp: Op = (state, { scope, params }) => {
  const vpc = find(state.vpcs, params.VpcId, KINDS.vpc)
  const tags = tagsFromSpecifications(params.TagSpecifications, 'route-table')
  const rtbId = newResourceId('route-table')
  const rtb: Resource = {
    RouteTableId: rtbId,
    OwnerId: scope.account,
    VpcId: vpc.VpcId,
    Routes: [{ DestinationCidrBlock: vpc.CidrBlock, GatewayId: 'local', Origin: 'CreateRouteTable', State: 'active' }],
    Associations: [],
    PropagatingVgws: [],
    Tags: tags,
  }
  state.routeTables[rtbId] = rtb
  return { RouteTable: rtb }
}

export const deleteRouteTableOp: Op = (state, { params }) => {
  const rtb = find(state.routeTables, params.RouteTableId, KINDS.routeTable)
  if (rtb.Associations.some((a: any) => a.Main || a.RouteTableAssociationId)) {
    throw new AwsError('DependencyViolation', `The routeTable '${rtb.RouteTableId}' has dependencies and cannot be deleted.`)
  }
  delete state.routeTables[rtb.RouteTableId]
}

export const createRouteOp: Op = (state, { params }) => {
  const rtb = find(state.routeTables, params.RouteTableId, KINDS.routeTable)
  if (!params.DestinationCidrBlock && !params.DestinationIpv6CidrBlock && !params.DestinationPrefixListId) {
    invalidValue('One of DestinationCidrBlock, DestinationIpv6CidrBlock, or DestinationPrefixListId must be specified')
  }
  const destination = params.DestinationCidrBlock || params.DestinationIpv6CidrBlock || params.DestinationPrefixListId
  if (rtb.Routes.some((r: any) => r.DestinationCidrBlock === destination || r.DestinationIpv6CidrBlock === destination)) {
    throw new AwsError('InvalidRoute.AlreadyExists', `The route identified by the destination CIDR '${destination}' already exists in the route table '${rtb.RouteTableId}'.`)
  }
  if (!params.GatewayId && !params.NetworkInterfaceId && !params.VpcPeeringConnectionId && !params.NatGatewayId && !params.InstanceId && !params.TransitGatewayId && !params.EgressOnlyInternetGatewayId && !params.LocalGatewayRouteTableId && !params.CarrierGatewayId && !params.CoreNetworkArn) {
    invalidValue('One of GatewayId, NetworkInterfaceId, VpcPeeringConnectionId, NatGatewayId, InstanceId, TransitGatewayId, EgressOnlyInternetGatewayId, LocalGatewayRouteTableId, CarrierGatewayId, or CoreNetworkArn must be specified')
  }
  if (params.GatewayId && !['local', ...Object.keys(state.internetGateways)].includes(params.GatewayId)) {
    throw new AwsError('InvalidParameterValue', `The Internet Gateway ID '${params.GatewayId}' does not exist`)
  }
  assertNatGateway(state, params.NatGatewayId)
  const route: any = {
    DestinationCidrBlock: params.DestinationCidrBlock,
    DestinationIpv6CidrBlock: params.DestinationIpv6CidrBlock,
    GatewayId: params.GatewayId,
    NetworkInterfaceId: params.NetworkInterfaceId,
    VpcPeeringConnectionId: params.VpcPeeringConnectionId,
    NatGatewayId: params.NatGatewayId,
    InstanceId: params.InstanceId,
    TransitGatewayId: params.TransitGatewayId,
    EgressOnlyInternetGatewayId: params.EgressOnlyInternetGatewayId,
    LocalGatewayRouteTableId: params.LocalGatewayRouteTableId,
    CarrierGatewayId: params.CarrierGatewayId,
    CoreNetworkArn: params.CoreNetworkArn,
    Origin: 'CreateRoute',
    State: 'active',
  }
  rtb.Routes.push(route)
  return { Return: true }
}

export const replaceRouteOp: Op = (state, { params }) => {
  const rtb = find(state.routeTables, params.RouteTableId, KINDS.routeTable)
  if (!params.DestinationCidrBlock && !params.DestinationIpv6CidrBlock) {
    invalidValue('One of DestinationCidrBlock or DestinationIpv6CidrBlock must be specified')
  }
  const destination = params.DestinationCidrBlock || params.DestinationIpv6CidrBlock
  const routeIndex = rtb.Routes.findIndex((r: any) => r.DestinationCidrBlock === destination || r.DestinationIpv6CidrBlock === destination)
  if (routeIndex === -1) {
    throw new AwsError('InvalidRoute.NotFound', `The route identified by the destination CIDR '${destination}' does not exist in the route table '${rtb.RouteTableId}'.`)
  }
  if (!params.GatewayId && !params.NetworkInterfaceId && !params.VpcPeeringConnectionId && !params.NatGatewayId && !params.InstanceId && !params.TransitGatewayId && !params.EgressOnlyInternetGatewayId && !params.LocalGatewayRouteTableId && !params.CarrierGatewayId && !params.CoreNetworkArn) {
    invalidValue('One of GatewayId, NetworkInterfaceId, VpcPeeringConnectionId, NatGatewayId, InstanceId, TransitGatewayId, EgressOnlyInternetGatewayId, LocalGatewayRouteTableId, CarrierGatewayId, or CoreNetworkArn must be specified')
  }
  if (params.GatewayId && !['local', ...Object.keys(state.internetGateways)].includes(params.GatewayId)) {
    throw new AwsError('InvalidParameterValue', `The Internet Gateway ID '${params.GatewayId}' does not exist`)
  }
  assertNatGateway(state, params.NatGatewayId)
  rtb.Routes[routeIndex] = {
    DestinationCidrBlock: params.DestinationCidrBlock,
    DestinationIpv6CidrBlock: params.DestinationIpv6CidrBlock,
    GatewayId: params.GatewayId,
    NetworkInterfaceId: params.NetworkInterfaceId,
    VpcPeeringConnectionId: params.VpcPeeringConnectionId,
    NatGatewayId: params.NatGatewayId,
    InstanceId: params.InstanceId,
    TransitGatewayId: params.TransitGatewayId,
    EgressOnlyInternetGatewayId: params.EgressOnlyInternetGatewayId,
    LocalGatewayRouteTableId: params.LocalGatewayRouteTableId,
    CarrierGatewayId: params.CarrierGatewayId,
    CoreNetworkArn: params.CoreNetworkArn,
    Origin: 'ReplaceRoute',
    State: 'active',
  }
  return { Return: true }
}

export const deleteRouteOp: Op = (state, { params }) => {
  const rtb = find(state.routeTables, params.RouteTableId, KINDS.routeTable)
  if (!params.DestinationCidrBlock && !params.DestinationIpv6CidrBlock) {
    invalidValue('One of DestinationCidrBlock or DestinationIpv6CidrBlock must be specified')
  }
  const destination = params.DestinationCidrBlock || params.DestinationIpv6CidrBlock
  const routeIndex = rtb.Routes.findIndex((r: any) => r.DestinationCidrBlock === destination || r.DestinationIpv6CidrBlock === destination)
  if (routeIndex === -1) {
    throw new AwsError('InvalidRoute.NotFound', `The route identified by the destination CIDR '${destination}' does not exist in the route table '${rtb.RouteTableId}'.`)
  }
  if (rtb.Routes[routeIndex].GatewayId === 'local') {
    throw new AwsError('InvalidRoute.InvalidState', `The route '${destination}' cannot be deleted because it is a local route.`)
  }
  rtb.Routes.splice(routeIndex, 1)
  return { Return: true }
}

export const associateRouteTableOp: Op = (state, { params }) => {
  const rtb = find(state.routeTables, params.RouteTableId, KINDS.routeTable)
  const subnet = find(state.subnets, params.SubnetId, KINDS.subnet)
  if (subnet.VpcId !== rtb.VpcId) {
    throw new AwsError('InvalidParameterValue', `The subnet '${subnet.SubnetId}' and route table '${rtb.RouteTableId}' do not belong to the same VPC.`)
  }
  const existing = rtb.Associations.find((a: any) => a.SubnetId === subnet.SubnetId)
  if (existing) {
    throw new AwsError('InvalidParameterValue', `The association ID '${existing.RouteTableAssociationId}' is already associated with the route table '${rtb.RouteTableId}'.`)
  }
  const associationId = newId('rtbassoc')
  const association = {
    Main: false,
    RouteTableAssociationId: associationId,
    RouteTableId: rtb.RouteTableId,
    SubnetId: subnet.SubnetId,
    AssociationState: { State: 'associated' },
  }
  rtb.Associations.push(association)
  return { AssociationId: associationId }
}

export const disassociateRouteTableOp: Op = (state, { params }) => {
  const associationId = params.AssociationId
  let association: any
  let rtb: any
  for (const rt of Object.values(state.routeTables)) {
    const found = rt.Associations.find((a: any) => a.RouteTableAssociationId === associationId)
    if (found) {
      association = found
      rtb = rt
      break
    }
  }
  if (!association) {
    throw new AwsError('InvalidAssociationID.NotFound', `The association ID '${associationId}' does not exist`)
  }
  if (association.Main) {
    throw new AwsError('InvalidParameterValue', `The association ID '${associationId}' cannot be disassociated; it is the main route table association.`)
  }
  const index = rtb.Associations.indexOf(association)
  rtb.Associations.splice(index, 1)
}

export const replaceRouteTableAssociationOp: Op = (state, { params }) => {
  const newRtb = find(state.routeTables, params.RouteTableId, KINDS.routeTable)
  const associationId = params.AssociationId
  let oldAssociation: any
  let oldRtb: any
  for (const rt of Object.values(state.routeTables)) {
    const found = rt.Associations.find((a: any) => a.RouteTableAssociationId === associationId)
    if (found) {
      oldAssociation = found
      oldRtb = rt
      break
    }
  }
  if (!oldAssociation) {
    throw new AwsError('InvalidAssociationID.NotFound', `The association ID '${associationId}' does not exist`)
  }
  if (oldAssociation.Main) {
    throw new AwsError('InvalidParameterValue', `The association ID '${associationId}' cannot be replaced; it is the main route table association.`)
  }
  const subnetId = oldAssociation.SubnetId
  const subnet = state.subnets[subnetId]
  if (newRtb.VpcId !== subnet.VpcId) {
    throw new AwsError('InvalidParameterValue', `The subnet '${subnetId}' and route table '${newRtb.RouteTableId}' do not belong to the same VPC.`)
  }
  const index = oldRtb.Associations.indexOf(oldAssociation)
  oldRtb.Associations.splice(index, 1)
  const newAssociationId = newId('rtbassoc')
  const newAssociation = {
    Main: false,
    RouteTableAssociationId: newAssociationId,
    RouteTableId: newRtb.RouteTableId,
    SubnetId: subnetId,
    AssociationState: { State: 'associated' },
  }
  newRtb.Associations.push(newAssociation)
  return { NewAssociationId: newAssociationId }
}

