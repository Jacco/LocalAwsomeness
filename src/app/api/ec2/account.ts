import { AwsError } from "../common"
import { listRegions } from "../data/account"
import { availabilityZones } from "../data/ec2/regions"
import { defaultVpc } from "../data/ec2/state"
import { describe } from "./describe"
import { KINDS, invalidValue, type Op } from "./request"

const OPT_IN_STATUS: Record<string, string> = {
  ENABLED_BY_DEFAULT: 'opt-in-not-required',
  ENABLED: 'opted-in',
  DISABLED: 'not-opted-in',
}

export const describeRegionsOp: Op = (_state, { scope, params }) => {
  const known = listRegions(scope.account)
  const names: string[] | undefined = params.RegionNames
  for (const name of names ?? []) {
    if (!(name in known)) {
      invalidValue(`Invalid region: ${name}`)
    }
  }
  const regions = Object.entries(known)
    .filter(([name]) => !names?.length || names.includes(name))
    .map(([name, status]) => ({
      RegionName: name,
      Endpoint: `ec2.${name}.amazonaws.com`,
      OptInStatus: OPT_IN_STATUS[status as string],
      Tags: [],
    }))
  // Regions the account has not opted in to are only listed on request.
  const visible = params.AllRegions || names?.length ? regions : regions.filter(r => r.OptInStatus !== 'not-opted-in')
  const { items } = describe({
    items: visible,
    idOf: r => r.RegionName,
    kind: KINDS.vpc,
    filters: params.Filters,
    filterFns: {
      endpoint: r => r.Endpoint,
      'opt-in-status': r => r.OptInStatus,
      'region-name': r => r.RegionName,
    },
  })
  return { Regions: items.map(({ Tags: _tags, ...region }) => region) }
}

export const describeAvailabilityZonesOp: Op = (_state, { scope, params }) => {
  const zones = availabilityZones(scope.region)
  for (const name of params.ZoneNames ?? []) {
    if (!zones.some(z => z.name === name)) {
      invalidValue(`Invalid availability zone: [${name}]`)
    }
  }
  for (const id of params.ZoneIds ?? []) {
    if (!zones.some(z => z.id === id)) {
      invalidValue(`Invalid zone id: [${id}]`)
    }
  }
  const items = zones
    .filter(z => !params.ZoneNames?.length || params.ZoneNames.includes(z.name))
    .filter(z => !params.ZoneIds?.length || params.ZoneIds.includes(z.id))
    .map(z => ({
      OptInStatus: 'opt-in-not-required',
      Messages: [],
      RegionName: scope.region,
      ZoneName: z.name,
      ZoneId: z.id,
      GroupName: scope.region,
      NetworkBorderGroup: scope.region,
      ZoneType: 'availability-zone',
      State: 'available',
      Tags: [],
    }))
  const result = describe({
    items,
    idOf: z => z.ZoneName,
    kind: KINDS.vpc,
    filters: params.Filters,
    filterFns: {
      'group-name': z => z.GroupName,
      message: () => [],
      'network-border-group': z => z.NetworkBorderGroup,
      'opt-in-status': z => z.OptInStatus,
      'parent-zone-id': () => [],
      'parent-zone-name': () => [],
      'region-name': z => z.RegionName,
      state: z => z.State,
      'zone-id': z => z.ZoneId,
      'zone-name': z => z.ZoneName,
      'zone-type': z => z.ZoneType,
    },
  })
  return { AvailabilityZones: result.items.map(({ Tags: _tags, ...zone }) => zone) }
}

const ACCOUNT_ATTRIBUTES: Record<string, (vpcId: string | undefined) => string[]> = {
  'supported-platforms': () => ['VPC'],
  'default-vpc': vpcId => [vpcId ?? 'none'],
  'max-instances': () => ['20'],
  'vpc-max-security-groups-per-interface': () => ['5'],
  'max-elastic-ips': () => ['5'],
  'vpc-max-elastic-ips': () => ['5'],
}

export const describeAccountAttributesOp: Op = (state, { params }) => {
  const names: string[] = params.AttributeNames?.length ? params.AttributeNames : Object.keys(ACCOUNT_ATTRIBUTES)
  const unknown = names.find(name => !(name in ACCOUNT_ATTRIBUTES))
  if (unknown) {
    throw new AwsError('InvalidParameterValue', `Value (${unknown}) for parameter attributeName is invalid.`)
  }
  const vpcId = defaultVpc(state)?.VpcId
  return {
    AccountAttributes: names.map(name => ({
      AttributeName: name,
      AttributeValues: ACCOUNT_ATTRIBUTES[name](vpcId).map(AttributeValue => ({ AttributeValue })),
    })),
  }
}
