import { AwsError } from "../common"
import type { Ec2State, Resource, Scope, Tag } from "../data/ec2/state"
import { QUOTAS, hardLimit } from "../quotas"
import type { DescribeSpec } from "./describe"

export interface Req<P = any> {
  scope: Scope
  principal: string
  params: P
}

export type Op = (state: Ec2State, req: Req) => unknown

type Kind = DescribeSpec<Resource>['kind']

// Error vocabulary per resource type (code prefix and the noun used in "The <noun> 'x' does not exist").
export const KINDS = {
  vpc: { prefix: 'vpc', code: 'InvalidVpcID', noun: 'vpc ID' },
  subnet: { prefix: 'subnet', code: 'InvalidSubnetID', noun: 'subnet ID' },
  routeTable: { prefix: 'rtb', code: 'InvalidRouteTableID', noun: 'route table ID' },
  networkAcl: { prefix: 'acl', code: 'InvalidNetworkAclID', noun: 'networkAcl ID', malformed: 'InvalidNetworkAclId.Malformed' },
  securityGroup: {
    prefix: 'sg', code: 'InvalidGroup', noun: 'security group', nounPlural: 'security groups', malformed: 'InvalidGroupId.Malformed',
  },
  securityGroupRule: {
    prefix: 'sgr', code: 'InvalidSecurityGroupRuleId', noun: 'security group rule ID', nounPlural: 'security group rule IDs',
  },
  internetGateway: { prefix: 'igw', code: 'InvalidInternetGatewayID', noun: 'internetGateway ID' },
  natGateway: {
    prefix: 'nat', code: 'NatGateway', noun: 'NAT gateway', nounPlural: 'NAT gateways',
    malformed: 'NatGatewayMalformed', notFound: 'NatGatewayNotFound',
  },
  address: { prefix: 'eipalloc', code: 'InvalidAllocationID', noun: 'allocation ID' },
  dhcpOptions: { prefix: 'dopt', code: 'InvalidDhcpOptionID', noun: 'dhcpOptions ID' },
  networkInterface: { prefix: 'eni', code: 'InvalidNetworkInterfaceID', noun: 'networkInterface ID' },
  vpcEndpoint: { prefix: 'vpce', code: 'InvalidVpcEndpointId', noun: 'VPC endpoint ID' },
} satisfies Record<string, Kind>

export function invalidValue(message: string): never {
  throw new AwsError('InvalidParameterValue', message)
}

export function missing(parameter: string): never {
  throw new AwsError('MissingParameter', `The request must contain the parameter ${parameter}`)
}

// Operations that are partly implemented (phase 4 is scoped by what the scenarios need) accept the parameters they handle
// and reject the others by name, instead of silently ignoring them.
export function assertSupported(params: Record<string, unknown>, supported: string[]): void {
  for (const name of Object.keys(params)) {
    if (!supported.includes(name) && params[name] !== undefined) {
      throw new AwsError('UnsupportedOperation', `The parameter ${name} is not supported by this simulator yet.`)
    }
  }
}

export function find<T extends Resource>(items: Record<string, T>, id: string, kind: Kind): T {
  if (!id.startsWith(`${kind.prefix}-`)) {
    throw new AwsError(kind.malformed ?? `${kind.code}.Malformed`, `Invalid id: "${id}" (expecting "${kind.prefix}-...")`)
  }
  const item = items[id]
  if (!item) {
    throw new AwsError(kind.notFound ?? `${kind.code}.NotFound`, `The ${kind.noun} '${id}' does not exist`)
  }
  return item
}

export function validateTags(tags: Tag[]) {
  for (const { Key, Value } of tags) {
    if (Key.startsWith('aws:')) {
      invalidValue("Tag keys starting with 'aws:' are reserved for internal use")
    }
    if (Key.length === 0 || Key.length > 128) {
      invalidValue(`Tag key must be between 1 and 128 characters in length`)
    }
    if ((Value ?? '').length > 256) {
      invalidValue(`Tag value exceeds the maximum length of 256 characters`)
    }
  }
}

// Tags passed with a create call; the specification must name the type being created.
export function tagsFromSpecifications(specs: { ResourceType?: string; Tags?: Tag[] }[] | undefined, resourceType: string): Tag[] {
  const tags: Tag[] = []
  for (const spec of specs ?? []) {
    if (spec.ResourceType !== resourceType) {
      invalidValue(`'${spec.ResourceType}' is not a valid resource type for this operation`)
    }
    for (const tag of spec.Tags ?? []) {
      const existing = tags.findIndex(t => t.Key === tag.Key)
      const normalized = { Key: tag.Key, Value: tag.Value ?? '' }
      if (existing >= 0) {
        tags[existing] = normalized
      } else {
        tags.push(normalized)
      }
    }
  }
  validateTags(tags)
  if (tags.length > hardLimit(QUOTAS.tagsPerResource)) {
    throw new AwsError('TagLimitExceeded', 'The maximum number of Tags for a resource has been reached.')
  }
  return tags
}
