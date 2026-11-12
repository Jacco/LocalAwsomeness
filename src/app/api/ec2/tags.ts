import { AwsError } from "../common"
import { resourceTypeOfId } from "../data/ec2/ids"
import { COLLECTIONS, type Ec2State, type Resource, type Tag } from "../data/ec2/state"
import { QUOTAS, hardLimit } from "../quotas"
import { describe } from "./describe"
import { KINDS, validateTags, type Op } from "./request"

const KIND_BY_TYPE = {
  vpc: KINDS.vpc,
  subnet: KINDS.subnet,
  'route-table': KINDS.routeTable,
  'network-acl': KINDS.networkAcl,
  'security-group': KINDS.securityGroup,
  'internet-gateway': KINDS.internetGateway,
  'dhcp-options': KINDS.dhcpOptions,
  'network-interface': KINDS.networkInterface,
  'nat-gateway': KINDS.natGateway,
  'elastic-ip': KINDS.address,
} as const

function findTaggable(state: Ec2State, id: string): { resource: Resource; type: string } {
  const type = resourceTypeOfId(id)
  const collection = type && COLLECTIONS[type]
  if (!type || !collection) {
    throw new AwsError('InvalidID', `The ID '${id}' is not valid`)
  }
  const resource = state[collection][id]
  if (!resource) {
    const kind = KIND_BY_TYPE[type as keyof typeof KIND_BY_TYPE]
    throw new AwsError(`${kind.code}.NotFound`, `The ${kind.noun} '${id}' does not exist`)
  }
  return { resource, type }
}

export const createTagsOp: Op = (state, { params }) => {
  if (!params.Resources?.length) {
    throw new AwsError('MissingParameter', 'The request must contain the parameter resourceIdSet')
  }
  const tags: Tag[] = (params.Tags ?? []).map((t: Tag) => ({ Key: t.Key, Value: t.Value ?? '' }))
  if (!tags.length) {
    throw new AwsError('MissingParameter', 'The request must contain the parameter tagSet')
  }
  validateTags(tags)
  const targets = params.Resources.map((id: string) => findTaggable(state, id).resource)
  for (const resource of targets) {
    const merged = [...resource.Tags]
    for (const tag of tags) {
      const index = merged.findIndex((t: Tag) => t.Key === tag.Key)
      if (index >= 0) {
        merged[index] = tag
      } else {
        merged.push(tag)
      }
    }
    if (merged.length > hardLimit(QUOTAS.tagsPerResource)) {
      throw new AwsError('TagLimitExceeded', 'The maximum number of Tags for a resource has been reached.')
    }
  }
  for (const resource of targets) {
    for (const tag of tags) {
      const index = resource.Tags.findIndex((t: Tag) => t.Key === tag.Key)
      if (index >= 0) {
        resource.Tags[index] = tag
      } else {
        resource.Tags.push(tag)
      }
    }
  }
}

// With a Value only tags holding that value are deleted; without Tags all tags are deleted.
export const deleteTagsOp: Op = (state, { params }) => {
  if (!params.Resources?.length) {
    throw new AwsError('MissingParameter', 'The request must contain the parameter resourceIdSet')
  }
  const targets: Resource[] = params.Resources.map((id: string) => findTaggable(state, id).resource)
  for (const resource of targets) {
    if (!params.Tags) {
      resource.Tags = []
      continue
    }
    resource.Tags = resource.Tags.filter((existing: Tag) =>
      !params.Tags.some((t: Tag) => t.Key === existing.Key && (t.Value === undefined || t.Value === existing.Value)))
  }
}

export const describeTagsOp: Op = (state, { params }) => {
  const descriptions: Resource[] = []
  for (const [type, collection] of Object.entries(COLLECTIONS)) {
    for (const [id, resource] of Object.entries(state[collection!])) {
      for (const tag of resource.Tags) {
        // the type of a NAT gateway in tags is `natgateway`, not the `nat-gateway` of its ID prefix
        descriptions.push({ ResourceId: id, ResourceType: type === 'nat-gateway' ? 'natgateway' : type, Key: tag.Key, Value: tag.Value, Tags: resource.Tags })
      }
    }
  }
  const { items, nextToken } = describe({
    items: descriptions,
    idOf: d => d.ResourceId,
    kind: KINDS.vpc,
    filters: params.Filters,
    maxResults: params.MaxResults,
    nextToken: params.NextToken,
    filterFns: {
      key: d => d.Key,
      value: d => d.Value,
      'resource-id': d => d.ResourceId,
      'resource-type': d => d.ResourceType,
    },
  })
  return { Tags: items, NextToken: nextToken }
}
