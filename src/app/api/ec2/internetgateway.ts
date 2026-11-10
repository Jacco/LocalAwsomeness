import { AwsError } from "../common"
import { newResourceId } from "../db/ec2/ids"
import type { Resource } from "../db/ec2/state"
import { KINDS, find, tagsFromSpecifications, type Op } from "./request"
import { natGatewayIsLive } from "./natgateway"

export const createInternetGatewayOp: Op = (state, { scope, params }) => {
  const tags = tagsFromSpecifications(params.TagSpecifications, 'internet-gateway')
  const igwId = newResourceId('internet-gateway')
  const igw: Resource = {
    InternetGatewayId: igwId,
    OwnerId: scope.account,
    Attachments: [],
    Tags: tags,
  }
  state.internetGateways[igwId] = igw
  return { InternetGateway: igw }
}

export const deleteInternetGatewayOp: Op = (state, { params }) => {
  const igw = find(state.internetGateways, params.InternetGatewayId, KINDS.internetGateway)
  if (igw.Attachments.length > 0) {
    throw new AwsError('DependencyViolation', `The Internet Gateway '${igw.InternetGatewayId}' has dependencies and cannot be deleted.`)
  }
  delete state.internetGateways[igw.InternetGatewayId]
}

export const attachInternetGatewayOp: Op = (state, { params }) => {
  const igw = find(state.internetGateways, params.InternetGatewayId, KINDS.internetGateway)
  const vpc = find(state.vpcs, params.VpcId, KINDS.vpc)
  if (igw.Attachments.some((a: any) => a.VpcId === vpc.VpcId)) {
    throw new AwsError('InvalidInternetGatewayID.AlreadyAttached', `The Internet Gateway '${igw.InternetGatewayId}' is already attached to VPC '${vpc.VpcId}'`)
  }
  igw.Attachments.push({ VpcId: vpc.VpcId, State: 'available' })
}

export const detachInternetGatewayOp: Op = (state, { params }) => {
  const igw = find(state.internetGateways, params.InternetGatewayId, KINDS.internetGateway)
  const vpc = find(state.vpcs, params.VpcId, KINDS.vpc)
  const attachmentIndex = igw.Attachments.findIndex((a: any) => a.VpcId === vpc.VpcId)
  if (attachmentIndex === -1) {
    throw new AwsError('InvalidInternetGatewayID.NotAttached', `The Internet Gateway '${igw.InternetGatewayId}' is not attached to VPC '${vpc.VpcId}'`)
  }
  // A public NAT gateway keeps a mapped public address in the VPC, which the internet gateway still serves.
  if (Object.values(state.natGateways).some(nat => nat.VpcId === vpc.VpcId && nat.ConnectivityType === 'public' && natGatewayIsLive(nat))) {
    throw new AwsError('DependencyViolation', `Network ${vpc.VpcId} has some mapped public address(es). Please unmap those public address(es) before detaching the gateway.`)
  }
  igw.Attachments.splice(attachmentIndex, 1)
}

