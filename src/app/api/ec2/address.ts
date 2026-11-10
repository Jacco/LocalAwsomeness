import { AwsError } from "../common"
import { allocatePublicIp } from "../db/ec2/interfaces"
import { newResourceId } from "../db/ec2/ids"
import { QUOTAS, quota } from "../quotas"
import { describe } from "./describe"
import { KINDS, assertSupported, find, invalidValue, tagsFromSpecifications, type Op } from "./request"

// Elastic IP addresses, VPC scope only. AllocateAddress / ReleaseAddress / DescribeAddresses exist; associating an address
// with an interface or instance is phase 4 work that no scenario needs yet (a NAT gateway associates its own address).

export const allocateAddressOp: Op = (state, { scope, params }) => {
  assertSupported(params, ['Domain', 'NetworkBorderGroup', 'TagSpecifications', 'DryRun'])
  if (params.Domain !== undefined && params.Domain !== 'vpc') {
    invalidValue(`Value (${params.Domain}) for parameter domain is invalid: only 'vpc' addresses can be allocated.`)
  }
  if (params.NetworkBorderGroup !== undefined && params.NetworkBorderGroup !== scope.region) {
    invalidValue(`Value (${params.NetworkBorderGroup}) for parameter networkBorderGroup is invalid: only the Region itself is supported.`)
  }
  if (Object.keys(state.addresses).length >= quota(scope, QUOTAS.elasticIpsPerRegion)) {
    throw new AwsError('AddressLimitExceeded', 'The maximum number of addresses has been reached.')
  }
  const tags = tagsFromSpecifications(params.TagSpecifications, 'elastic-ip')
  const allocationId = newResourceId('elastic-ip')
  const address = {
    AllocationId: allocationId,
    PublicIp: allocatePublicIp(state),
    Domain: 'vpc',
    PublicIpv4Pool: 'amazon',
    NetworkBorderGroup: scope.region,
    Tags: tags,
  }
  state.addresses[allocationId] = address
  return { AllocationId: allocationId, PublicIp: address.PublicIp, Domain: 'vpc', PublicIpv4Pool: 'amazon', NetworkBorderGroup: scope.region }
}

export const releaseAddressOp: Op = (state, { scope, params }) => {
  assertSupported(params, ['AllocationId', 'NetworkBorderGroup', 'DryRun'])
  if (params.NetworkBorderGroup !== undefined && params.NetworkBorderGroup !== scope.region) {
    invalidValue(`Value (${params.NetworkBorderGroup}) for parameter networkBorderGroup is invalid: only the Region itself is supported.`)
  }
  if (params.AllocationId === undefined) {
    throw new AwsError('MissingParameter', 'You must specify an allocation id when releasing a VPC elastic IP address')
  }
  const address = find(state.addresses, params.AllocationId, KINDS.address)
  if (address.AssociationId) {
    throw new AwsError('InvalidIPAddress.InUse', `The address '${address.AllocationId}' is associated (association id ${address.AssociationId}) and cannot be released.`)
  }
  delete state.addresses[address.AllocationId]
}

// Only the VPC form (by association id). Associations that exist today belong to NAT gateways, which own them: the address
// is freed when the NAT gateway is deleted. Terraform calls this with the association it still has in its state, and an
// association that is already gone is `InvalidAssociationID.NotFound`, which the provider accepts.
export const disassociateAddressOp: Op = (state, { params }) => {
  assertSupported(params, ['AssociationId', 'DryRun'])
  if (params.AssociationId === undefined) {
    throw new AwsError('MissingParameter', 'You must specify an association id when unmapping an address from a VPC instance')
  }
  const address = Object.values(state.addresses).find(a => a.AssociationId === params.AssociationId)
  if (!address) {
    throw new AwsError('InvalidAssociationID.NotFound', `The association ID '${params.AssociationId}' does not exist`)
  }
  if (state.networkInterfaces[address.NetworkInterfaceId]?.RequesterManaged) {
    throw new AwsError('OperationNotPermitted', `The address ${address.AllocationId} is in use by an AWS service (a NAT gateway) and cannot be disassociated`)
  }
  for (const field of ['AssociationId', 'NetworkInterfaceId', 'NetworkInterfaceOwnerId', 'PrivateIpAddress']) {
    delete address[field]
  }
}

export const describeAddressesOp: Op = (state, { params }) => {
  let addresses = Object.values(state.addresses)
  const ips: string[] | undefined = params.PublicIps
  if (ips?.length) {
    const unknown = ips.find(ip => !addresses.some(a => a.PublicIp === ip))
    if (unknown) {
      throw new AwsError('InvalidAddress.NotFound', `Address '${unknown}' not found.`)
    }
    addresses = addresses.filter(a => ips.includes(a.PublicIp))
  }
  const { items } = describe({
    items: addresses,
    idOf: a => a.AllocationId,
    ids: params.AllocationIds,
    kind: KINDS.address,
    filters: params.Filters,
    filterFns: {
      'allocation-id': a => a.AllocationId,
      'association-id': a => a.AssociationId,
      domain: a => a.Domain,
      'instance-id': a => a.InstanceId,
      'network-border-group': a => a.NetworkBorderGroup,
      'network-interface-id': a => a.NetworkInterfaceId,
      'network-interface-owner-id': a => a.NetworkInterfaceOwnerId,
      'private-ip-address': a => a.PrivateIpAddress,
      'public-ip': a => a.PublicIp,
    },
  })
  return { Addresses: items }
}
