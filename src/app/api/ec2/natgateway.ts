import { AwsError } from "../common"
import { newId, newResourceId } from "../db/ec2/ids"
import { createInterface } from "../db/ec2/interfaces"
import type { Ec2State, Resource } from "../db/ec2/state"
import { QUOTAS, quota } from "../quotas"
import { describe } from "./describe"
import { KINDS, assertSupported, find, missing, tagsFromSpecifications, type Op } from "./request"

// NAT gateways: public (with an Elastic IP) and private. A NAT gateway owns a requester-managed network interface in its
// subnet and, when public, holds an Elastic IP. States are instant like the rest of this service: it is `available` when
// created and `deleted` when deleted (AWS goes through `pending` and `deleting`), and a deleted NAT gateway stays visible
// for an hour as in AWS.
//
// Supported parameters: SubnetId, AllocationId, ConnectivityType, TagSpecification, ClientToken (echoed, not used for
// idempotency). Secondary addresses and the other parameters are rejected by name.

const DELETED_VISIBLE_MS = 60 * 60 * 1000
// States that count toward the quota of NAT gateways per Availability Zone.
const COUNTED = ['pending', 'available', 'deleting']

const isLive = (nat: Resource) => !['deleting', 'deleted', 'failed'].includes(nat.State)

function pruneDeleted(state: Ec2State) {
  for (const nat of Object.values(state.natGateways)) {
    if (nat.State === 'deleted' && Date.now() - Date.parse(nat.DeleteTime) > DELETED_VISIBLE_MS) {
      delete state.natGateways[nat.NatGatewayId]
    }
  }
}

export const createNatGatewayOp: Op = (state, { scope, params }) => {
  assertSupported(params, ['SubnetId', 'AllocationId', 'ConnectivityType', 'TagSpecifications', 'ClientToken', 'DryRun'])
  if (!params.SubnetId) {
    missing('SubnetId')
  }
  const subnet = find(state.subnets, params.SubnetId, KINDS.subnet)
  const type: string = params.ConnectivityType ?? 'public'
  let address: Resource | undefined
  if (type === 'public') {
    if (!params.AllocationId) {
      missing('AllocationId')
    }
    address = find(state.addresses, params.AllocationId, KINDS.address)
    if (address.AssociationId) {
      throw new AwsError('Resource.AlreadyAssociated', `resource ${address.AllocationId} is already associated with associate-id ${address.AssociationId}.`)
    }
  } else if (params.AllocationId) {
    throw new AwsError('InvalidParameterCombination', 'AllocationId cannot be specified for a private NAT gateway.')
  }
  const inZone = Object.values(state.natGateways)
    .filter(nat => COUNTED.includes(nat.State) && state.subnets[nat.SubnetId]?.AvailabilityZone === subnet.AvailabilityZone)
  if (inZone.length >= quota(scope, QUOTAS.natGatewaysPerAvailabilityZone)) {
    throw new AwsError('NatGatewayLimitExceeded', 'The maximum number of NAT Gateways has been reached.')
  }
  const tags = tagsFromSpecifications(params.TagSpecifications, 'natgateway')

  const natId = newResourceId('nat-gateway')
  const eni = createInterface(state, scope, {
    subnetId: subnet.SubnetId,
    description: `Interface for NAT Gateway ${natId}`,
    interfaceType: 'nat_gateway',
    requesterManaged: true,
    sourceDestCheck: false,
  })
  const nat: Resource = {
    NatGatewayId: natId,
    VpcId: subnet.VpcId,
    SubnetId: subnet.SubnetId,
    State: 'available',
    ConnectivityType: type,
    CreateTime: new Date().toISOString(),
    NatGatewayAddresses: [{ NetworkInterfaceId: eni.NetworkInterfaceId, PrivateIp: eni.PrivateIpAddress, IsPrimary: true, Status: 'succeeded' }],
    Tags: tags,
  }
  if (address) {
    const associationId = newId('eipassoc')
    address.AssociationId = associationId
    address.NetworkInterfaceId = eni.NetworkInterfaceId
    address.NetworkInterfaceOwnerId = scope.account
    address.PrivateIpAddress = eni.PrivateIpAddress
    const association = {
      AllocationId: address.AllocationId,
      AssociationId: associationId,
      IpOwnerId: 'amazon',
      PublicIp: address.PublicIp,
      PublicDnsName: `ec2-${address.PublicIp.replace(/\./g, '-')}.${scope.region}.compute.amazonaws.com`,
    }
    eni.Association = association
    eni.PrivateIpAddresses[0].Association = association
    Object.assign(nat.NatGatewayAddresses[0], { AllocationId: address.AllocationId, PublicIp: address.PublicIp, AssociationId: associationId })
  }
  pruneDeleted(state)
  state.natGateways[natId] = nat
  return { NatGateway: nat, ClientToken: params.ClientToken }
}

// Deleting returns the interface address to the subnet and frees the Elastic IP (which stays allocated to the account).
export const deleteNatGatewayOp: Op = (state, { params }) => {
  assertSupported(params, ['NatGatewayId', 'DryRun'])
  const nat = find(state.natGateways, params.NatGatewayId, KINDS.natGateway)
  if (isLive(nat)) {
    for (const entry of nat.NatGatewayAddresses as Resource[]) {
      delete state.networkInterfaces[entry.NetworkInterfaceId]
      const address = state.addresses[entry.AllocationId]
      if (address && address.AssociationId === entry.AssociationId) {
        for (const field of ['AssociationId', 'NetworkInterfaceId', 'NetworkInterfaceOwnerId', 'PrivateIpAddress']) {
          delete address[field]
        }
      }
    }
    nat.State = 'deleted'
    nat.DeleteTime = new Date().toISOString()
  }
  pruneDeleted(state)
  return { NatGatewayId: nat.NatGatewayId }
}

export const describeNatGatewaysOp: Op = (state, { params }) => {
  const { items, nextToken } = describe({
    items: Object.values(state.natGateways),
    idOf: nat => nat.NatGatewayId,
    ids: params.NatGatewayIds,
    kind: KINDS.natGateway,
    // this operation names its filter parameter `Filter`, not `Filters`
    filters: params.Filter,
    maxResults: params.MaxResults,
    nextToken: params.NextToken,
    filterFns: {
      'nat-gateway-id': nat => nat.NatGatewayId,
      state: nat => nat.State,
      'subnet-id': nat => nat.SubnetId,
      'vpc-id': nat => nat.VpcId,
    },
  })
  return { NatGateways: items, NextToken: nextToken }
}

export const natGatewayIsLive = isLive
