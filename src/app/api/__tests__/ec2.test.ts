import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseStringPromise } from 'xml2js'

// All state goes to a temporary db/ root, so these tests exercise the real store and handlers.
const root = mkdtempSync(join(tmpdir(), 'jpk-ec2-'))
process.env.JPK_DB_ROOT = root
const ACCOUNT = '123456789012'

/* eslint-disable @typescript-eslint/no-require-imports */
const { ec2 } = require('@/app/api/ec2/service')
const { provisionAccount } = require('@/app/api/data/ec2/state')

const headers = (region: string) => ({
  'content-type': 'application/x-www-form-urlencoded',
  'x-aws-principal': `arn:aws:iam::${ACCOUNT}:role/admin`,
  'x-aws-userid': 'AROAEXAMPLE',
  authorization: `AWS4-HMAC-SHA256 Credential=KEY/20250101/${region}/ec2/aws4_request, SignedHeaders=host, Signature=abc`,
})

interface Result {
  status: number
  raw: string
  body: any
}

async function call(action: string, params: Record<string, string> = {}, region = 'eu-west-1'): Promise<Result> {
  const body = new URLSearchParams({ Action: action, Version: '2016-11-15', ...params }).toString()
  const response: Response = await ec2.post(new Request('http://localhost/api/ec2', { method: 'POST', body, headers: headers(region) }))
  const raw = await response.text()
  return { status: response.status, raw, body: await parseStringPromise(raw, { explicitArray: false }) }
}

const items = (set: any): any[] => (set?.item === undefined ? [] : [].concat(set.item))
const error = (r: Result) => ({ status: r.status, code: r.body.Response.Errors.Error.Code, message: r.body.Response.Errors.Error.Message })

const createVpc = async (cidr: string, tags?: Record<string, string>) => {
  const params: Record<string, string> = { CidrBlock: cidr }
  if (tags) {
    params['TagSpecification.1.ResourceType'] = 'vpc'
    Object.entries(tags).forEach(([k, v], i) => {
      params[`TagSpecification.1.Tag.${i + 1}.Key`] = k
      params[`TagSpecification.1.Tag.${i + 1}.Value`] = v
    })
  }
  return call('CreateVpc', params)
}

beforeAll(() => mkdirSync(join(root, ACCOUNT), { recursive: true }))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('ec2 default VPC', () => {
  it('provisions a default VPC with a subnet per AZ, an IGW and default objects on first use', async () => {
    const vpcs = items((await call('DescribeVpcs')).body.DescribeVpcsResponse.vpcSet)
    expect(vpcs).toHaveLength(1)
    expect(vpcs[0]).toMatchObject({ cidrBlock: '172.31.0.0/16', isDefault: 'true', state: 'available', instanceTenancy: 'default' })

    const subnets = items((await call('DescribeSubnets', { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpcs[0].vpcId })).body.DescribeSubnetsResponse.subnetSet)
    expect(subnets.map(s => [s.cidrBlock, s.availabilityZone, s.defaultForAz, s.mapPublicIpOnLaunch])).toEqual([
      ['172.31.0.0/20', 'eu-west-1a', 'true', 'true'],
      ['172.31.16.0/20', 'eu-west-1b', 'true', 'true'],
      ['172.31.32.0/20', 'eu-west-1c', 'true', 'true'],
    ])
    expect(subnets[0].availableIpAddressCount).toBe('4091')

    const igws = items((await call('DescribeInternetGateways')).body.DescribeInternetGatewaysResponse.internetGatewaySet)
    expect(igws).toHaveLength(1)
    expect(items(igws[0].attachmentSet)[0]).toMatchObject({ vpcId: vpcs[0].vpcId, state: 'available' })

    const attributes = items((await call('DescribeAccountAttributes', { 'AttributeName.1': 'default-vpc' })).body.DescribeAccountAttributesResponse.accountAttributeSet)
    expect(attributes[0].attributeValueSet.item.attributeValue).toBe(vpcs[0].vpcId)
  })

  it('creates a default VPC in every region enabled by default when an account is provisioned', () => {
    provisionAccount('210987654321')
    const regions = readdirSync(join(root, '210987654321'))
    expect(regions).toContain('eu-west-1')
    expect(regions).toContain('us-east-1')
    expect(regions).not.toContain('af-south-1')
    expect(regions).toHaveLength(17)
  })

  it('rejects creating a second default VPC', async () => {
    expect(error(await call('CreateDefaultVpc'))).toMatchObject({ code: 'DefaultVpcAlreadyExists', status: 400 })
  })
})

describe('ec2 VPCs', () => {
  it('creates a VPC with its implicit main route table, default NACL and default security group', async () => {
    const created = await createVpc('10.0.0.0/16', { Name: 'main', env: 'test' })
    expect(created.status).toBe(200)
    expect(created.raw).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<CreateVpcResponse xmlns="http:\/\/ec2.amazonaws.com\/doc\/2016-11-15\/"><requestId>/)
    const vpc = created.body.CreateVpcResponse.vpc
    expect(vpc.vpcId).toMatch(/^vpc-[0-9a-f]{17}$/)
    expect(vpc.cidrBlockAssociationSet.item.associationId).toMatch(/^vpc-cidr-assoc-[0-9a-f]{17}$/)
    expect(items(vpc.tagSet).map(t => [t.key, t.value])).toEqual([['Name', 'main'], ['env', 'test']])

    const filter = { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpc.vpcId }
    const routeTables = items((await call('DescribeRouteTables', filter)).body.DescribeRouteTablesResponse.routeTableSet)
    expect(routeTables).toHaveLength(1)
    expect(routeTables[0].associationSet.item.main).toBe('true')
    expect(routeTables[0].routeSet.item).toMatchObject({ destinationCidrBlock: '10.0.0.0/16', gatewayId: 'local', origin: 'CreateRouteTable', state: 'active' })

    const acls = items((await call('DescribeNetworkAcls', filter)).body.DescribeNetworkAclsResponse.networkAclSet)
    expect(acls).toHaveLength(1)
    expect(acls[0].default).toBe('true')
    expect(items(acls[0].entrySet).map(e => [e.egress, e.ruleNumber, e.ruleAction])).toEqual([
      ['true', '100', 'allow'], ['true', '32767', 'deny'], ['false', '100', 'allow'], ['false', '32767', 'deny'],
    ])

    const groups = items((await call('DescribeSecurityGroups', filter)).body.DescribeSecurityGroupsResponse.securityGroupInfo)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ groupName: 'default', groupDescription: 'default VPC security group' })
    expect(groups[0].ipPermissions.item.groups.item.groupId).toBe(groups[0].groupId)
    expect(groups[0].ipPermissionsEgress.item.ipRanges.item.cidrIp).toBe('0.0.0.0/0')

    expect((await call('DeleteVpc', { VpcId: vpc.vpcId })).raw).toContain('<return>true</return>')
    expect(items((await call('DescribeRouteTables', filter)).body.DescribeRouteTablesResponse.routeTableSet)).toHaveLength(0)
  })

  it('validates CIDR blocks', async () => {
    expect(error(await createVpc('10.0.0.1/16'))).toEqual({
      status: 400, code: 'InvalidParameterValue',
      message: 'Value (10.0.0.1/16) for parameter cidrBlock is invalid. This is not a valid CIDR block.',
    })
    expect(error(await createVpc('10.0.0.0/8'))).toMatchObject({ code: 'InvalidVpc.Range', message: "The CIDR '10.0.0.0/8' is invalid." })
    expect(error(await createVpc('10.0.0.0/29'))).toMatchObject({ code: 'InvalidVpc.Range' })
    expect(error(await call('CreateVpc'))).toMatchObject({ code: 'MissingParameter' })
  })

  it('enforces the VPC limit of 5 per region', async () => {
    const ids: string[] = []
    for (let i = 1; i <= 4; i++) {
      ids.push((await createVpc(`10.${i}.0.0/16`)).body.CreateVpcResponse.vpc.vpcId)
    }
    expect(error(await createVpc('10.9.0.0/16'))).toMatchObject({ code: 'VpcLimitExceeded', message: 'The maximum number of VPCs has been reached.' })
    for (const id of ids) {
      await call('DeleteVpc', { VpcId: id })
    }
  })

  it('filters, supports wildcards and legacy filter names, and rejects unknown filters', async () => {
    const created = (await createVpc('10.50.0.0/16', { Name: 'filter-me' })).body.CreateVpcResponse.vpc.vpcId
    const ids = async (params: Record<string, string>) =>
      items((await call('DescribeVpcs', params)).body.DescribeVpcsResponse.vpcSet).map(v => v.vpcId)

    expect(await ids({ 'Filter.1.Name': 'tag:Name', 'Filter.1.Value.1': 'filter-*' })).toEqual([created])
    expect(await ids({ 'Filter.1.Name': 'cidr', 'Filter.1.Value.1': '10.50.0.0/16' })).toEqual([created])
    expect(await ids({ 'Filter.1.Name': 'tag-key', 'Filter.1.Value.1': 'Name', 'Filter.2.Name': 'state', 'Filter.2.Value.1': 'pending' })).toEqual([])
    expect(await ids({ 'Filter.1.Name': 'isDefault', 'Filter.1.Value.1': 'true' })).toHaveLength(1)
    expect(error(await call('DescribeVpcs', { 'Filter.1.Name': 'bogus', 'Filter.1.Value.1': 'x' })))
      .toEqual({ status: 400, code: 'InvalidParameterValue', message: "The filter 'bogus' is invalid" })
    await call('DeleteVpc', { VpcId: created })
  })

  it('reports not found and malformed ids', async () => {
    expect(error(await call('DescribeVpcs', { 'VpcId.1': 'vpc-0123456789abcdef0' })))
      .toEqual({ status: 400, code: 'InvalidVpcID.NotFound', message: "The vpc ID 'vpc-0123456789abcdef0' does not exist" })
    expect(error(await call('DescribeVpcs', { 'VpcId.1': 'foo' }))).toMatchObject({ code: 'InvalidVpcID.Malformed' })
    expect(error(await call('DeleteVpc', { VpcId: 'vpc-0123456789abcdef0' }))).toMatchObject({ code: 'InvalidVpcID.NotFound' })
  })

  it('modifies and describes VPC attributes one at a time', async () => {
    const vpc = (await createVpc('10.60.0.0/16')).body.CreateVpcResponse.vpc.vpcId
    const attribute = async (name: string) =>
      (await call('DescribeVpcAttribute', { VpcId: vpc, Attribute: name })).body.DescribeVpcAttributeResponse
    expect((await attribute('enableDnsSupport')).enableDnsSupport.value).toBe('true')
    expect((await attribute('enableDnsHostnames')).enableDnsHostnames.value).toBe('false')

    await call('ModifyVpcAttribute', { VpcId: vpc, 'EnableDnsHostnames.Value': 'true' })
    expect((await attribute('enableDnsHostnames')).enableDnsHostnames.value).toBe('true')

    expect(error(await call('ModifyVpcAttribute', { VpcId: vpc, 'EnableDnsHostnames.Value': 'true', 'EnableDnsSupport.Value': 'false' })))
      .toMatchObject({ code: 'InvalidParameterCombination' })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('associates and disassociates secondary CIDR blocks and updates local routes', async () => {
    const vpc = (await createVpc('10.70.0.0/16')).body.CreateVpcResponse.vpc.vpcId
    const associated = (await call('AssociateVpcCidrBlock', { VpcId: vpc, CidrBlock: '10.71.0.0/16' })).body.AssociateVpcCidrBlockResponse
    expect(associated.cidrBlockAssociation).toMatchObject({ cidrBlock: '10.71.0.0/16', cidrBlockState: { state: 'associated' } })

    const routes = async () => items((await call('DescribeRouteTables', { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpc })).body.DescribeRouteTablesResponse.routeTableSet)[0].routeSet.item
    expect(await routes()).toHaveLength(2)
    expect(error(await call('AssociateVpcCidrBlock', { VpcId: vpc, CidrBlock: '10.71.0.0/17' }))).toMatchObject({ code: 'InvalidVpc.Range' })

    const primary = items((await call('DescribeVpcs', { 'VpcId.1': vpc })).body.DescribeVpcsResponse.vpcSet)[0].cidrBlockAssociationSet.item[0].associationId
    expect(error(await call('DisassociateVpcCidrBlock', { AssociationId: primary }))).toMatchObject({ code: 'OperationNotPermitted' })

    await call('DisassociateVpcCidrBlock', { AssociationId: associated.cidrBlockAssociation.associationId })
    expect(await routes()).toMatchObject({ destinationCidrBlock: '10.70.0.0/16' })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('answers DryRun with DryRunOperation (412) without changing anything', async () => {
    const before = items((await call('DescribeVpcs')).body.DescribeVpcsResponse.vpcSet).length
    expect(error(await call('CreateVpc', { CidrBlock: '10.80.0.0/16', DryRun: 'true' })))
      .toEqual({ status: 412, code: 'DryRunOperation', message: 'Request would have succeeded, but DryRun flag is set.' })
    expect(items((await call('DescribeVpcs')).body.DescribeVpcsResponse.vpcSet)).toHaveLength(before)
    expect(error(await call('CreateVpc', { CidrBlock: 'nope', DryRun: 'true' })).code).toBe('InvalidParameterValue')
  })
})

describe('ec2 subnets', () => {
  let vpc: string

  beforeAll(async () => {
    vpc = (await createVpc('10.100.0.0/16')).body.CreateVpcResponse.vpc.vpcId
  })

  it('creates a subnet in a chosen AZ, associated with the default NACL', async () => {
    const created = await call('CreateSubnet', { VpcId: vpc, CidrBlock: '10.100.1.0/24', AvailabilityZone: 'eu-west-1b' })
    const subnet = created.body.CreateSubnetResponse.subnet
    expect(subnet).toMatchObject({
      vpcId: vpc, cidrBlock: '10.100.1.0/24', availabilityZone: 'eu-west-1b', availabilityZoneId: 'euw1-az2',
      state: 'available', availableIpAddressCount: '251', defaultForAz: 'false', mapPublicIpOnLaunch: 'false', ownerId: ACCOUNT,
    })
    expect(subnet.subnetArn).toBe(`arn:aws:ec2:eu-west-1:${ACCOUNT}:subnet/${subnet.subnetId}`)

    const acl = items((await call('DescribeNetworkAcls', { 'Filter.1.Name': 'association.subnet-id', 'Filter.1.Value.1': subnet.subnetId })).body.DescribeNetworkAclsResponse.networkAclSet)
    expect(acl).toHaveLength(1)
    expect(acl[0].default).toBe('true')
  })

  it('validates range, conflicts, zones and ids', async () => {
    expect(error(await call('CreateSubnet', { VpcId: vpc, CidrBlock: '10.100.1.0/25', AvailabilityZone: 'eu-west-1a' })))
      .toEqual({ status: 400, code: 'InvalidSubnet.Conflict', message: "The CIDR '10.100.1.0/25' conflicts with another subnet" })
    expect(error(await call('CreateSubnet', { VpcId: vpc, CidrBlock: '192.168.0.0/24' })))
      .toMatchObject({ code: 'InvalidSubnet.Range', message: "The CIDR '192.168.0.0/24' is invalid." })
    expect(error(await call('CreateSubnet', { VpcId: vpc, CidrBlock: '10.100.9.0/24', AvailabilityZone: 'eu-west-1z' })))
      .toMatchObject({
        code: 'InvalidParameterValue',
        message: 'Value (eu-west-1z) for parameter availabilityZone is invalid. Subnets can currently only be created in the following availability zones: eu-west-1a, eu-west-1b, eu-west-1c.',
      })
    expect(error(await call('CreateSubnet', { VpcId: 'vpc-0123456789abcdef0', CidrBlock: '10.100.9.0/24' }))).toMatchObject({ code: 'InvalidVpcID.NotFound' })
    expect(error(await call('CreateSubnet', { CidrBlock: '10.100.9.0/24' }))).toMatchObject({ code: 'MissingParameter' })
  })

  it('modifies one subnet attribute at a time', async () => {
    const id = (await call('CreateSubnet', { VpcId: vpc, CidrBlock: '10.100.2.0/24' })).body.CreateSubnetResponse.subnet.subnetId
    await call('ModifySubnetAttribute', { SubnetId: id, 'MapPublicIpOnLaunch.Value': 'true' })
    expect(items((await call('DescribeSubnets', { 'SubnetId.1': id })).body.DescribeSubnetsResponse.subnetSet)[0].mapPublicIpOnLaunch).toBe('true')
    expect(error(await call('ModifySubnetAttribute', { SubnetId: id, 'MapPublicIpOnLaunch.Value': 'true', 'EnableDns64.Value': 'true' })))
      .toMatchObject({ code: 'InvalidParameterCombination' })
  })

  it('blocks DeleteVpc while subnets exist and cleans up associations on DeleteSubnet', async () => {
    expect(error(await call('DeleteVpc', { VpcId: vpc })))
      .toEqual({ status: 400, code: 'DependencyViolation', message: `The vpc '${vpc}' has dependencies and cannot be deleted.` })

    for (const subnet of items((await call('DescribeSubnets', { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpc })).body.DescribeSubnetsResponse.subnetSet)) {
      expect((await call('DeleteSubnet', { SubnetId: subnet.subnetId })).status).toBe(200)
    }
    const acl = items((await call('DescribeNetworkAcls', { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpc })).body.DescribeNetworkAclsResponse.networkAclSet)[0]
    expect(items(acl.associationSet)).toHaveLength(0)
    expect((await call('DeleteVpc', { VpcId: vpc })).status).toBe(200)
  })

  it('paginates with MaxResults and NextToken', async () => {
    const first = (await call('DescribeSubnets', { MaxResults: '5' })).body.DescribeSubnetsResponse
    expect(items(first.subnetSet)).toHaveLength(3)
    expect(first.nextToken).toBeUndefined()
    expect(error(await call('DescribeSubnets', { MaxResults: '2' }))).toMatchObject({ code: 'InvalidParameterValue' })
  })
})

describe('ec2 tags', () => {
  it('creates, describes and deletes tags across resource types', async () => {
    const vpc = (await createVpc('10.110.0.0/16')).body.CreateVpcResponse.vpc.vpcId
    const subnet = (await call('CreateSubnet', { VpcId: vpc, CidrBlock: '10.110.1.0/24' })).body.CreateSubnetResponse.subnet.subnetId

    await call('CreateTags', { 'ResourceId.1': vpc, 'ResourceId.2': subnet, 'Tag.1.Key': 'team', 'Tag.1.Value': 'net', 'Tag.2.Key': 'flag' })
    const described = items((await call('DescribeTags', { 'Filter.1.Name': 'resource-id', 'Filter.1.Value.1': vpc, 'Filter.1.Value.2': subnet })).body.DescribeTagsResponse.tagSet)
    expect(described.map(t => [t.resourceType, t.key, t.value]).sort()).toEqual([
      ['subnet', 'flag', ''], ['subnet', 'team', 'net'], ['vpc', 'flag', ''], ['vpc', 'team', 'net'],
    ])

    await call('DeleteTags', { 'ResourceId.1': vpc, 'Tag.1.Key': 'team', 'Tag.1.Value': 'other' })
    await call('DeleteTags', { 'ResourceId.1': vpc, 'Tag.1.Key': 'flag' })
    expect(items(items((await call('DescribeVpcs', { 'VpcId.1': vpc })).body.DescribeVpcsResponse.vpcSet)[0].tagSet).map(t => t.key)).toEqual(['team'])

    await call('DeleteTags', { 'ResourceId.1': vpc })
    expect(items(items((await call('DescribeVpcs', { 'VpcId.1': vpc })).body.DescribeVpcsResponse.vpcSet)[0].tagSet)).toHaveLength(0)

    await call('DeleteSubnet', { SubnetId: subnet })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('rejects reserved keys, unknown resources and invalid ids', async () => {
    const vpc = items((await call('DescribeVpcs')).body.DescribeVpcsResponse.vpcSet)[0].vpcId
    expect(error(await call('CreateTags', { 'ResourceId.1': vpc, 'Tag.1.Key': 'aws:x', 'Tag.1.Value': 'y' })))
      .toEqual({ status: 400, code: 'InvalidParameterValue', message: "Tag keys starting with 'aws:' are reserved for internal use" })
    expect(error(await call('CreateTags', { 'ResourceId.1': 'subnet-0123456789abcdef0', 'Tag.1.Key': 'k', 'Tag.1.Value': 'v' }))).toMatchObject({ code: 'InvalidSubnetID.NotFound' })
    expect(error(await call('CreateTags', { 'ResourceId.1': 'bogus', 'Tag.1.Key': 'k', 'Tag.1.Value': 'v' }))).toMatchObject({ code: 'InvalidID' })
  })
})

describe('ec2 account and region info', () => {
  it('lists availability zones with zone ids and rejects unknown zones', async () => {
    const zones = items((await call('DescribeAvailabilityZones')).body.DescribeAvailabilityZonesResponse.availabilityZoneInfo)
    expect(zones.map(z => [z.zoneName, z.zoneId, z.regionName, z.zoneState])).toEqual([
      ['eu-west-1a', 'euw1-az1', 'eu-west-1', 'available'],
      ['eu-west-1b', 'euw1-az2', 'eu-west-1', 'available'],
      ['eu-west-1c', 'euw1-az3', 'eu-west-1', 'available'],
    ])
    expect(error(await call('DescribeAvailabilityZones', { 'ZoneName.1': 'eu-west-1z' }))).toMatchObject({ code: 'InvalidParameterValue' })
  })

  it('lists enabled regions with endpoints', async () => {
    const regions = items((await call('DescribeRegions')).body.DescribeRegionsResponse.regionInfo)
    expect(regions).toHaveLength(17)
    expect(regions.find(r => r.regionName === 'eu-west-1')).toMatchObject({ regionEndpoint: 'ec2.eu-west-1.amazonaws.com', optInStatus: 'opt-in-not-required' })
  })

  it('uses a different state and default VPC per region', async () => {
    const west = items((await call('DescribeVpcs')).body.DescribeVpcsResponse.vpcSet)[0].vpcId
    const central = items((await call('DescribeVpcs', {}, 'eu-central-1')).body.DescribeVpcsResponse.vpcSet)[0].vpcId
    expect(central).not.toBe(west)
    const domain = items((await call('DescribeDhcpOptions', {}, 'us-east-1')).body.DescribeDhcpOptionsResponse.dhcpOptionsSet)[0].dhcpConfigurationSet.item[0].valueSet.item.value
    expect(domain).toBe('ec2.internal')
  })

  it('rejects unknown actions with InvalidAction', async () => {
    expect(error(await call('RunInstances'))).toEqual({ status: 400, code: 'InvalidAction', message: 'The action RunInstances is not valid for this web service.' })
  })
})


describe('ec2 internet gateways (phase 2)', () => {
  it('creates and deletes internet gateways', async () => {
    const igw = (await call('CreateInternetGateway', { 'TagSpecification.1.ResourceType': 'internet-gateway', 'TagSpecification.1.Tag.1.Key': 'Name', 'TagSpecification.1.Tag.1.Value': 'test-igw' }))
      .body.CreateInternetGatewayResponse.internetGateway
    expect(igw.internetGatewayId).toMatch(/^igw-[0-9a-f]{17}$/)
    expect(items(igw.tagSet).map(t => [t.key, t.value])).toEqual([['Name', 'test-igw']])

    const described = items((await call('DescribeInternetGateways', { 'InternetGatewayId.1': igw.internetGatewayId })).body.DescribeInternetGatewaysResponse.internetGatewaySet)
    expect(described).toHaveLength(1)
    expect(described[0].internetGatewayId).toBe(igw.internetGatewayId)
    expect(items(described[0].attachmentSet)).toHaveLength(0)

    expect((await call('DeleteInternetGateway', { InternetGatewayId: igw.internetGatewayId })).status).toBe(200)
    expect(error(await call('DescribeInternetGateways', { 'InternetGatewayId.1': igw.internetGatewayId }))).toMatchObject({ code: 'InvalidInternetGatewayID.NotFound' })
  })

  it('attaches and detaches internet gateways from VPCs', async () => {
    const vpc = (await createVpc('10.0.0.0/16')).body.CreateVpcResponse.vpc.vpcId
    const igw = (await call('CreateInternetGateway')).body.CreateInternetGatewayResponse.internetGateway.internetGatewayId

    expect((await call('AttachInternetGateway', { InternetGatewayId: igw, VpcId: vpc })).status).toBe(200)
    const attached = items((await call('DescribeInternetGateways', { 'InternetGatewayId.1': igw })).body.DescribeInternetGatewaysResponse.internetGatewaySet)[0]
    expect(attached.attachmentSet.item).toMatchObject({ vpcId: vpc, state: 'available' })

    expect(error(await call('AttachInternetGateway', { InternetGatewayId: igw, VpcId: vpc }))).toMatchObject({ code: 'InvalidInternetGatewayID.AlreadyAttached' })
    expect((await call('DetachInternetGateway', { InternetGatewayId: igw, VpcId: vpc })).status).toBe(200)
    expect(items(items((await call('DescribeInternetGateways', { 'InternetGatewayId.1': igw })).body.DescribeInternetGatewaysResponse.internetGatewaySet)[0].attachmentSet)).toHaveLength(0)

    expect(error(await call('DetachInternetGateway', { InternetGatewayId: igw, VpcId: vpc }))).toMatchObject({ code: 'InvalidInternetGatewayID.NotAttached' })
    expect((await call('DeleteInternetGateway', { InternetGatewayId: igw })).status).toBe(200)
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('rejects deleting an attached internet gateway', async () => {
    const vpc = (await createVpc('10.1.0.0/16')).body.CreateVpcResponse.vpc.vpcId
    const igw = (await call('CreateInternetGateway')).body.CreateInternetGatewayResponse.internetGateway.internetGatewayId
    await call('AttachInternetGateway', { InternetGatewayId: igw, VpcId: vpc })
    expect(error(await call('DeleteInternetGateway', { InternetGatewayId: igw }))).toMatchObject({ code: 'DependencyViolation' })
    await call('DetachInternetGateway', { InternetGatewayId: igw, VpcId: vpc })
    await call('DeleteInternetGateway', { InternetGatewayId: igw })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('filters internet gateways by attachment and tags', async () => {
    const vpc = (await createVpc('10.2.0.0/16')).body.CreateVpcResponse.vpc.vpcId
    const igw1 = (await call('CreateInternetGateway', { 'TagSpecification.1.ResourceType': 'internet-gateway', 'TagSpecification.1.Tag.1.Key': 'env', 'TagSpecification.1.Tag.1.Value': 'prod' }))
      .body.CreateInternetGatewayResponse.internetGateway.internetGatewayId
    const igw2 = (await call('CreateInternetGateway')).body.CreateInternetGatewayResponse.internetGateway.internetGatewayId
    await call('AttachInternetGateway', { InternetGatewayId: igw1, VpcId: vpc })

    const byVpc = items((await call('DescribeInternetGateways', { 'Filter.1.Name': 'attachment.vpc-id', 'Filter.1.Value.1': vpc })).body.DescribeInternetGatewaysResponse.internetGatewaySet)
    expect(byVpc.map(g => g.internetGatewayId)).toEqual([igw1])

    const byTag = items((await call('DescribeInternetGateways', { 'Filter.1.Name': 'tag:env', 'Filter.1.Value.1': 'prod' })).body.DescribeInternetGatewaysResponse.internetGatewaySet)
    expect(byTag.map(g => g.internetGatewayId)).toEqual([igw1])

    await call('DetachInternetGateway', { InternetGatewayId: igw1, VpcId: vpc })
    for (const id of [igw1, igw2]) {
      await call('DeleteInternetGateway', { InternetGatewayId: id })
    }
    await call('DeleteVpc', { VpcId: vpc })
  })
})

describe('ec2 route tables (phase 2)', () => {
  it('creates and deletes route tables', async () => {
    const vpc = (await createVpc('10.0.0.0/16')).body.CreateVpcResponse.vpc.vpcId
    const rtb = (await call('CreateRouteTable', { VpcId: vpc, 'TagSpecification.1.ResourceType': 'route-table', 'TagSpecification.1.Tag.1.Key': 'Name', 'TagSpecification.1.Tag.1.Value': 'custom' }))
      .body.CreateRouteTableResponse.routeTable
    expect(rtb.routeTableId).toMatch(/^rtb-[0-9a-f]{17}$/)
    expect(items(rtb.routeSet)).toHaveLength(1)
    expect(items(rtb.routeSet)[0]).toMatchObject({ destinationCidrBlock: '10.0.0.0/16', gatewayId: 'local', origin: 'CreateRouteTable', state: 'active' })

    expect((await call('DeleteRouteTable', { RouteTableId: rtb.routeTableId })).status).toBe(200)
    expect(error(await call('DescribeRouteTables', { 'RouteTableId.1': rtb.routeTableId }))).toMatchObject({ code: 'InvalidRouteTableID.NotFound' })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('creates, replaces and deletes routes', async () => {
    const vpc = (await createVpc('10.0.0.0/16')).body.CreateVpcResponse.vpc.vpcId
    const rtb = (await call('CreateRouteTable', { VpcId: vpc })).body.CreateRouteTableResponse.routeTable.routeTableId
    const igw = (await call('CreateInternetGateway')).body.CreateInternetGatewayResponse.internetGateway.internetGatewayId
    await call('AttachInternetGateway', { InternetGatewayId: igw, VpcId: vpc })

    expect((await call('CreateRoute', { RouteTableId: rtb, DestinationCidrBlock: '0.0.0.0/0', GatewayId: igw })).status).toBe(200)
    const withRoute = items((await call('DescribeRouteTables', { 'RouteTableId.1': rtb })).body.DescribeRouteTablesResponse.routeTableSet)[0]
    expect(items(withRoute.routeSet)).toHaveLength(2)
    expect(items(withRoute.routeSet).find(r => r.destinationCidrBlock === '0.0.0.0/0')).toMatchObject({ gatewayId: igw, origin: 'CreateRoute', state: 'active' })

    expect(error(await call('CreateRoute', { RouteTableId: rtb, DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'local' }))).toMatchObject({ code: 'InvalidRoute.AlreadyExists' })

    expect((await call('ReplaceRoute', { RouteTableId: rtb, DestinationCidrBlock: '0.0.0.0/0', GatewayId: igw })).status).toBe(200)
    const replaced = items((await call('DescribeRouteTables', { 'RouteTableId.1': rtb })).body.DescribeRouteTablesResponse.routeTableSet)[0]
    expect(items(replaced.routeSet).find(r => r.destinationCidrBlock === '0.0.0.0/0')).toMatchObject({ gatewayId: igw, origin: 'ReplaceRoute', state: 'active' })

    expect((await call('DeleteRoute', { RouteTableId: rtb, DestinationCidrBlock: '0.0.0.0/0' })).status).toBe(200)
    const afterDelete = items((await call('DescribeRouteTables', { 'RouteTableId.1': rtb })).body.DescribeRouteTablesResponse.routeTableSet)[0]
    expect(items(afterDelete.routeSet)).toHaveLength(1)

    expect(error(await call('DeleteRoute', { RouteTableId: rtb, DestinationCidrBlock: '10.0.0.0/16' }))).toMatchObject({ code: 'InvalidRoute.InvalidState' })

    await call('DetachInternetGateway', { InternetGatewayId: igw, VpcId: vpc })
    await call('DeleteInternetGateway', { InternetGatewayId: igw })
    await call('DeleteRouteTable', { RouteTableId: rtb })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('associates, disassociates and replaces route table associations', async () => {
    const vpc = (await createVpc('10.0.0.0/16')).body.CreateVpcResponse.vpc.vpcId
    const subnet = (await call('CreateSubnet', { VpcId: vpc, CidrBlock: '10.0.1.0/24' })).body.CreateSubnetResponse.subnet.subnetId
    const rtb1 = (await call('CreateRouteTable', { VpcId: vpc })).body.CreateRouteTableResponse.routeTable.routeTableId
    const rtb2 = (await call('CreateRouteTable', { VpcId: vpc })).body.CreateRouteTableResponse.routeTable.routeTableId

    const assocId = (await call('AssociateRouteTable', { RouteTableId: rtb1, SubnetId: subnet })).body.AssociateRouteTableResponse.associationId
    expect(assocId).toMatch(/^rtbassoc-[0-9a-f]{17}$/)

    const subnet_rtbs = items((await call('DescribeRouteTables', { 'Filter.1.Name': 'association.subnet-id', 'Filter.1.Value.1': subnet })).body.DescribeRouteTablesResponse.routeTableSet)
    expect(subnet_rtbs).toHaveLength(1)
    const subnet_rtb = subnet_rtbs[0]
    expect(subnet_rtb.routeTableId).toBe(rtb1)
    const assocs = items(subnet_rtb.associationSet)
    expect(assocs.find(a => a.subnetId === subnet)).toMatchObject({ routeTableAssociationId: assocId, main: 'false' })

    expect((await call('DisassociateRouteTable', { AssociationId: assocId })).status).toBe(200)
    const afterDisassoc = items((await call('DescribeRouteTables', { 'Filter.1.Name': 'association.subnet-id', 'Filter.1.Value.1': subnet })).body.DescribeRouteTablesResponse.routeTableSet)
    expect(afterDisassoc).toHaveLength(0)

    const assocId2 = (await call('AssociateRouteTable', { RouteTableId: rtb1, SubnetId: subnet })).body.AssociateRouteTableResponse.associationId
    const newAssocId = (await call('ReplaceRouteTableAssociation', { AssociationId: assocId2, RouteTableId: rtb2 })).body.ReplaceRouteTableAssociationResponse.newAssociationId
    const after_replace = items((await call('DescribeRouteTables', { 'Filter.1.Name': 'association.subnet-id', 'Filter.1.Value.1': subnet })).body.DescribeRouteTablesResponse.routeTableSet)[0]
    expect(after_replace.routeTableId).toBe(rtb2)
    const after_assocs = items(after_replace.associationSet)
    expect(after_assocs.find(a => a.subnetId === subnet)).toMatchObject({ routeTableAssociationId: newAssocId, main: 'false' })

    await call('DisassociateRouteTable', { AssociationId: newAssocId })
    for (const id of [rtb1, rtb2]) {
      await call('DeleteRouteTable', { RouteTableId: id })
    }
    await call('DeleteSubnet', { SubnetId: subnet })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('keeps route tables that are still in use', async () => {
    const vpc = (await createVpc('10.0.0.0/16')).body.CreateVpcResponse.vpc.vpcId
    const subnet = (await call('CreateSubnet', { VpcId: vpc, CidrBlock: '10.0.1.0/24' })).body.CreateSubnetResponse.subnet.subnetId
    const rtb = (await call('CreateRouteTable', { VpcId: vpc })).body.CreateRouteTableResponse.routeTable.routeTableId
    const assoc = (await call('AssociateRouteTable', { RouteTableId: rtb, SubnetId: subnet })).body.AssociateRouteTableResponse.associationId
    const main = items((await call('DescribeRouteTables', { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpc, 'Filter.2.Name': 'association.main', 'Filter.2.Value.1': 'true' })).body.DescribeRouteTablesResponse.routeTableSet)[0].routeTableId

    expect(error(await call('DeleteRouteTable', { RouteTableId: rtb }))).toMatchObject({ code: 'DependencyViolation' })
    expect(error(await call('DeleteRouteTable', { RouteTableId: main }))).toMatchObject({ code: 'DependencyViolation' })
    expect(error(await call('DeleteVpc', { VpcId: vpc }))).toMatchObject({ code: 'DependencyViolation' })

    // deleting the subnet drops its association, which frees the route table
    expect((await call('DeleteSubnet', { SubnetId: subnet })).status).toBe(200)
    expect(error(await call('DisassociateRouteTable', { AssociationId: assoc }))).toMatchObject({ code: 'InvalidAssociationID.NotFound' })
    expect((await call('DeleteRouteTable', { RouteTableId: rtb })).status).toBe(200)
    expect((await call('DeleteVpc', { VpcId: vpc })).status).toBe(200)
    // the main route table went with the VPC
    expect(error(await call('DescribeRouteTables', { 'RouteTableId.1': main }))).toMatchObject({ code: 'InvalidRouteTableID.NotFound' })
  })

  it('rejects invalid route and association operations', async () => {
    const vpc = (await createVpc('10.0.0.0/16')).body.CreateVpcResponse.vpc.vpcId
    const subnet = (await call('CreateSubnet', { VpcId: vpc, CidrBlock: '10.0.1.0/24' })).body.CreateSubnetResponse.subnet.subnetId
    const rtb = (await call('CreateRouteTable', { VpcId: vpc })).body.CreateRouteTableResponse.routeTable.routeTableId
    const other_vpc = (await createVpc('10.1.0.0/16')).body.CreateVpcResponse.vpc.vpcId
    const other_vpc_rtb = (await call('CreateRouteTable', { VpcId: other_vpc })).body.CreateRouteTableResponse.routeTable.routeTableId

    expect(error(await call('CreateRoute', { RouteTableId: rtb, GatewayId: 'igw-invalid' }))).toMatchObject({ code: 'InvalidParameterValue' })
    expect(error(await call('AssociateRouteTable', { RouteTableId: other_vpc_rtb, SubnetId: subnet }))).toMatchObject({ code: 'InvalidParameterValue', message: /do not belong to the same VPC/ })

    await call('DeleteRouteTable', { RouteTableId: rtb })
    await call('DeleteRouteTable', { RouteTableId: other_vpc_rtb })
    await call('DeleteSubnet', { SubnetId: subnet })
    await call('DeleteVpc', { VpcId: vpc })
    await call('DeleteVpc', { VpcId: other_vpc })
  })

  it('filters route tables by VPC, routes and associations', async () => {
    const vpc = (await createVpc('10.0.0.0/16')).body.CreateVpcResponse.vpc.vpcId
    const subnet = (await call('CreateSubnet', { VpcId: vpc, CidrBlock: '10.0.1.0/24' })).body.CreateSubnetResponse.subnet.subnetId
    const rtb = (await call('CreateRouteTable', { VpcId: vpc })).body.CreateRouteTableResponse.routeTable.routeTableId
    const igw = (await call('CreateInternetGateway')).body.CreateInternetGatewayResponse.internetGateway.internetGatewayId
    await call('AttachInternetGateway', { InternetGatewayId: igw, VpcId: vpc })
    await call('CreateRoute', { RouteTableId: rtb, DestinationCidrBlock: '0.0.0.0/0', GatewayId: igw })
    await call('AssociateRouteTable', { RouteTableId: rtb, SubnetId: subnet })

    const byVpc = items((await call('DescribeRouteTables', { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpc })).body.DescribeRouteTablesResponse.routeTableSet)
    expect(byVpc.map(t => t.routeTableId)).toContain(rtb)

    const byRoute = items((await call('DescribeRouteTables', { 'Filter.1.Name': 'route.gateway-id', 'Filter.1.Value.1': igw })).body.DescribeRouteTablesResponse.routeTableSet)
    expect(byRoute.map(t => t.routeTableId)).toContain(rtb)

    const bySubnet = items((await call('DescribeRouteTables', { 'Filter.1.Name': 'association.subnet-id', 'Filter.1.Value.1': subnet })).body.DescribeRouteTablesResponse.routeTableSet)
    expect(bySubnet.map(t => t.routeTableId)).toEqual([rtb])

    const subnetAssocs = items(bySubnet[0].associationSet)
    const subnetAssoc = subnetAssocs.find(a => a.subnetId === subnet)
    await call('DisassociateRouteTable', { AssociationId: subnetAssoc.associationId })
    await call('DeleteRoute', { RouteTableId: rtb, DestinationCidrBlock: '0.0.0.0/0' })
    await call('DeleteRouteTable', { RouteTableId: rtb })
    await call('DetachInternetGateway', { InternetGatewayId: igw, VpcId: vpc })
    await call('DeleteInternetGateway', { InternetGatewayId: igw })
    await call('DeleteSubnet', { SubnetId: subnet })
    await call('DeleteVpc', { VpcId: vpc })
  })
})

// ---------------------------------------------------------------------------
// phase 3: security groups and network ACLs
// ---------------------------------------------------------------------------

interface Permission {
  protocol: string
  from?: number
  to?: number
  cidr?: string
  cidr6?: string
  group?: string
  description?: string
}

// IpPermissions.<n>.* parameters of one rule specification.
function permission(n: number, p: Permission): Record<string, string> {
  const prefix = `IpPermissions.${n}.`
  const params: Record<string, string> = { [`${prefix}IpProtocol`]: p.protocol }
  if (p.from !== undefined) params[`${prefix}FromPort`] = String(p.from)
  if (p.to !== undefined) params[`${prefix}ToPort`] = String(p.to)
  if (p.cidr) params[`${prefix}IpRanges.1.CidrIp`] = p.cidr
  if (p.cidr6) params[`${prefix}Ipv6Ranges.1.CidrIpv6`] = p.cidr6
  if (p.group) params[`${prefix}Groups.1.GroupId`] = p.group
  if (p.description !== undefined) {
    const key = p.cidr ? 'IpRanges' : p.cidr6 ? 'Ipv6Ranges' : 'Groups'
    params[`${prefix}${key}.1.Description`] = p.description
  }
  return params
}

const vpcOf = async (cidr: string) => (await createVpc(cidr)).body.CreateVpcResponse.vpc.vpcId as string
const groupOf = async (vpcId: string, name: string) =>
  (await call('CreateSecurityGroup', { GroupName: name, GroupDescription: `${name} group`, VpcId: vpcId })).body.CreateSecurityGroupResponse.groupId as string
const describeGroup = async (groupId: string) =>
  items((await call('DescribeSecurityGroups', { 'GroupId.1': groupId })).body.DescribeSecurityGroupsResponse.securityGroupInfo)[0]
const rulesOfGroup = async (groupId: string) =>
  items((await call('DescribeSecurityGroupRules', { 'Filter.1.Name': 'group-id', 'Filter.1.Value.1': groupId })).body.DescribeSecurityGroupRulesResponse.securityGroupRuleSet)

describe('ec2 security groups (phase 3)', () => {
  it('creates a group with the default egress rule, tags and an ARN', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const created = (await call('CreateSecurityGroup', {
      GroupName: 'web', GroupDescription: 'web servers', VpcId: vpc,
      'TagSpecification.1.ResourceType': 'security-group', 'TagSpecification.1.Tag.1.Key': 'Name', 'TagSpecification.1.Tag.1.Value': 'web',
    })).body.CreateSecurityGroupResponse
    expect(created.groupId).toMatch(/^sg-[0-9a-f]{17}$/)
    expect(created.securityGroupArn).toBe(`arn:aws:ec2:eu-west-1:${ACCOUNT}:security-group/${created.groupId}`)

    const group = await describeGroup(created.groupId)
    expect(group).toMatchObject({ groupName: 'web', groupDescription: 'web servers', vpcId: vpc, ownerId: ACCOUNT })
    expect(items(group.tagSet)).toEqual([{ key: 'Name', value: 'web' }])
    expect(items(group.ipPermissions)).toHaveLength(0)
    const egress = items(group.ipPermissionsEgress)
    expect(egress).toHaveLength(1)
    expect(egress[0]).toMatchObject({ ipProtocol: '-1' })
    expect(items(egress[0].ipRanges)).toEqual([{ cidrIp: '0.0.0.0/0' }])

    expect((await call('DeleteSecurityGroup', { GroupId: created.groupId })).status).toBe(200)
    expect(error(await call('DescribeSecurityGroups', { 'GroupId.1': created.groupId }))).toMatchObject({ code: 'InvalidGroup.NotFound' })
    expect(await rulesOfGroup(created.groupId)).toHaveLength(0)
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('validates names, descriptions and the VPC on create', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    await groupOf(vpc, 'taken')
    const create = (GroupName: string, extra: Record<string, string> = {}) =>
      call('CreateSecurityGroup', { GroupName, GroupDescription: 'd', VpcId: vpc, ...extra })
    expect(error(await create('taken'))).toMatchObject({ code: 'InvalidGroup.Duplicate' })
    expect(error(await create('default'))).toMatchObject({ code: 'InvalidGroup.Reserved' })
    expect(error(await create('sg-mine'))).toMatchObject({ code: 'InvalidParameterValue' })
    expect(error(await create('bad\u00e9name'))).toMatchObject({ code: 'InvalidParameterValue' })
    expect(error(await create('x'.repeat(256)))).toMatchObject({ code: 'InvalidParameterValue' })
    expect(error(await create('ok', { VpcId: 'vpc-0123456789abcdef0' }))).toMatchObject({ code: 'InvalidVpcID.NotFound' })
    expect(error(await call('CreateSecurityGroup', { GroupName: 'nodesc', VpcId: vpc }))).toMatchObject({ code: 'MissingParameter' })
    // the same name is fine in another VPC
    const other = await vpcOf('10.1.0.0/16')
    expect((await call('CreateSecurityGroup', { GroupName: 'taken', GroupDescription: 'd', VpcId: other })).status).toBe(200)
    await call('DeleteVpc', { VpcId: other }).then(r => expect(error(r)).toMatchObject({ code: 'DependencyViolation' }))
    for (const id of [vpc, other]) {
      const groups = items((await call('DescribeSecurityGroups', { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': id })).body.DescribeSecurityGroupsResponse.securityGroupInfo)
      for (const g of groups.filter(g => g.groupName !== 'default')) {
        await call('DeleteSecurityGroup', { GroupId: g.groupId })
      }
      await call('DeleteVpc', { VpcId: id })
    }
  })

  it('uses the default VPC when no VPC is given and finds groups by name there', async () => {
    const created = (await call('CreateSecurityGroup', { GroupName: 'in-default', GroupDescription: 'd' })).body.CreateSecurityGroupResponse.groupId
    const defaultVpcId = items((await call('DescribeVpcs', { 'Filter.1.Name': 'is-default', 'Filter.1.Value.1': 'true' })).body.DescribeVpcsResponse.vpcSet)[0].vpcId
    expect((await describeGroup(created)).vpcId).toBe(defaultVpcId)
    expect((await call('AuthorizeSecurityGroupIngress', { GroupName: 'in-default', IpProtocol: 'tcp', FromPort: '80', ToPort: '80', CidrIp: '0.0.0.0/0' })).status).toBe(200)
    expect(items((await describeGroup(created)).ipPermissions)).toHaveLength(1)
    expect((await call('DeleteSecurityGroup', { GroupName: 'in-default' })).status).toBe(200)
    expect(error(await call('DeleteSecurityGroup', { GroupName: 'in-default' }))).toMatchObject({ code: 'InvalidGroup.NotFound' })
    expect(error(await call('DeleteSecurityGroup', {}))).toMatchObject({ code: 'MissingParameter' })
  })

  it('authorizes ingress and egress rules and reports them as rules and permissions', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const web = await groupOf(vpc, 'web')
    const db = await groupOf(vpc, 'db')
    const response = (await call('AuthorizeSecurityGroupIngress', {
      GroupId: db,
      ...permission(1, { protocol: 'tcp', from: 5432, to: 5432, group: web, description: 'from web' }),
      ...permission(2, { protocol: 'tcp', from: 22, to: 22, cidr: '10.0.0.77/24', description: 'ssh' }),
      ...permission(3, { protocol: 'icmp', from: -1, to: -1, cidr6: '::/0' }),
      ...permission(4, { protocol: '-1', cidr: '192.168.0.0/16' }),
      'TagSpecification.1.ResourceType': 'security-group-rule', 'TagSpecification.1.Tag.1.Key': 'owner', 'TagSpecification.1.Tag.1.Value': 'team',
    })).body.AuthorizeSecurityGroupIngressResponse
    expect(response.return).toBe('true')
    const created = items(response.securityGroupRuleSet)
    expect(created).toHaveLength(4)
    expect(created[0].securityGroupRuleId).toMatch(/^sgr-[0-9a-f]{17}$/)
    expect(created[0]).toMatchObject({ groupId: db, isEgress: 'false', ipProtocol: 'tcp', fromPort: '5432', toPort: '5432', referencedGroupInfo: { groupId: web }, description: 'from web' })
    expect(created[1]).toMatchObject({ cidrIpv4: '10.0.0.0/24', ipProtocol: 'tcp' })
    expect(created[2]).toMatchObject({ cidrIpv6: '::/0', ipProtocol: 'icmp', fromPort: '-1', toPort: '-1' })
    expect(created[3]).toMatchObject({ cidrIpv4: '192.168.0.0/16', ipProtocol: '-1', fromPort: '-1', toPort: '-1' })
    expect(items(created[0].tagSet)).toEqual([{ key: 'owner', value: 'team' }])

    const permissions = items((await describeGroup(db)).ipPermissions)
    expect(permissions.map(p => p.ipProtocol)).toEqual(['tcp', 'tcp', 'icmp', '-1'])
    expect(items(permissions[0].groups)).toEqual([{ groupId: web, userId: ACCOUNT, description: 'from web' }])
    expect(items(permissions[1].ipRanges)).toEqual([{ cidrIp: '10.0.0.0/24', description: 'ssh' }])

    expect((await call('AuthorizeSecurityGroupEgress', { GroupId: db, ...permission(1, { protocol: 'udp', from: 53, to: 53, cidr: '10.0.0.2/32' }) })).status).toBe(200)
    const rules = await rulesOfGroup(db)
    expect(rules.filter(r => r.isEgress === 'true')).toHaveLength(2) // the default egress rule and the new one
    expect(rules.filter(r => r.isEgress === 'false')).toHaveLength(4)

    const byId = items((await call('DescribeSecurityGroupRules', { 'SecurityGroupRuleId.1': created[1].securityGroupRuleId })).body.DescribeSecurityGroupRulesResponse.securityGroupRuleSet)
    expect(byId.map(r => r.securityGroupRuleId)).toEqual([created[1].securityGroupRuleId])
    const byFilter = items((await call('DescribeSecurityGroups', { 'Filter.1.Name': 'ip-permission.group-id', 'Filter.1.Value.1': web })).body.DescribeSecurityGroupsResponse.securityGroupInfo)
    expect(byFilter.map(g => g.groupId)).toEqual([db])
    expect(error(await call('DescribeSecurityGroupRules', { 'SecurityGroupRuleId.1': 'rule-1' }))).toMatchObject({ code: 'InvalidSecurityGroupRuleId.Malformed' })
    expect(error(await call('DescribeSecurityGroupRules', { 'SecurityGroupRuleId.1': 'sgr-0123456789abcdef0' }))).toMatchObject({ code: 'InvalidSecurityGroupRuleId.NotFound' })

    for (const id of [db, web]) await call('DeleteSecurityGroup', { GroupId: id })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('rejects duplicate, malformed and invalid rules without applying any of the request', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const group = await groupOf(vpc, 'strict')
    const authorize = (...permissions: Record<string, string>[]) =>
      call('AuthorizeSecurityGroupIngress', { GroupId: group, ...Object.assign({}, ...permissions) })
    expect((await authorize(permission(1, { protocol: 'tcp', from: 22, to: 22, cidr: '10.0.0.0/8' }))).status).toBe(200)

    const duplicate = error(await authorize(permission(1, { protocol: 'tcp', from: 22, to: 22, cidr: '10.0.0.0/8', description: 'again' })))
    expect(duplicate).toMatchObject({ code: 'InvalidPermission.Duplicate' })
    expect(duplicate.message).toBe('The specified rule "peer: 10.0.0.0/8, TCP, from port: 22, to port: 22, ALLOW" already exists')
    // a duplicate inside one request, and a valid rule next to a duplicate: nothing is added
    expect(error(await authorize(permission(1, { protocol: 'tcp', from: 80, to: 80, cidr: '10.0.0.0/8' }), permission(2, { protocol: 'tcp', from: 80, to: 80, cidr: '10.0.0.0/8' })))).toMatchObject({ code: 'InvalidPermission.Duplicate' })
    expect(error(await authorize(permission(1, { protocol: 'tcp', from: 443, to: 443, cidr: '10.0.0.0/8' }), permission(2, { protocol: 'tcp', from: 22, to: 22, cidr: '10.0.0.0/8' })))).toMatchObject({ code: 'InvalidPermission.Duplicate' })
    expect((await rulesOfGroup(group)).filter(r => r.isEgress === 'false')).toHaveLength(1)

    expect(error(await authorize(permission(1, { protocol: 'tcp', from: 22, to: 22, cidr: '10.0.0.0/33' }))).code).toBe('InvalidPermission.Malformed')
    expect(error(await authorize(permission(1, { protocol: 'tcp', from: 22, to: 22, cidr6: 'nope/64' }))).code).toBe('InvalidPermission.Malformed')
    expect(error(await authorize(permission(1, { protocol: 'tcp', from: 22, to: 22 }))).code).toBe('InvalidPermission.Malformed')
    expect(error(await authorize(permission(1, { protocol: 'bogus', cidr: '10.0.0.0/8' }))).code).toBe('InvalidParameterValue')
    expect(error(await authorize(permission(1, { protocol: 'tcp', cidr: '10.0.0.0/8' }))).code).toBe('InvalidParameterValue')
    expect(error(await authorize(permission(1, { protocol: 'tcp', from: 100, to: 50, cidr: '10.0.0.0/8' }))).code).toBe('InvalidParameterValue')
    expect(error(await authorize(permission(1, { protocol: 'tcp', from: 0, to: 70000, cidr: '10.0.0.0/8' }))).code).toBe('InvalidParameterValue')
    expect(error(await authorize(permission(1, { protocol: 'icmp', cidr: '10.0.0.0/8' }))).code).toBe('InvalidParameterValue')
    expect(error(await authorize(permission(1, { protocol: 'tcp', from: 22, to: 22, group: 'sg-0123456789abcdef0' }))).code).toBe('InvalidGroup.NotFound')
    expect(error(await authorize(permission(1, { protocol: 'tcp', from: 22, to: 22, group: 'nonsense' }))).code).toBe('InvalidGroupId.Malformed')
    expect(error(await call('AuthorizeSecurityGroupIngress', { GroupId: group, CidrIp: '10.0.0.0/8', ...permission(1, { protocol: 'tcp', from: 1, to: 1, cidr: '10.0.0.0/8' }) })).code).toBe('InvalidParameterCombination')
    expect(error(await call('AuthorizeSecurityGroupIngress', { GroupId: group })).code).toBe('MissingParameter')
    expect(error(await call('AuthorizeSecurityGroupIngress', { GroupId: 'sg-0123456789abcdef0', ...permission(1, { protocol: '-1', cidr: '10.0.0.0/8' }) })).code).toBe('InvalidGroup.NotFound')
    // prefix lists do not exist yet
    expect(error(await call('AuthorizeSecurityGroupIngress', { GroupId: group, 'IpPermissions.1.IpProtocol': '-1', 'IpPermissions.1.PrefixListIds.1.PrefixListId': 'pl-0123456789abcdef0' })).code).toBe('InvalidPrefixListID.NotFound')
    // a group of another VPC cannot be referenced
    const otherVpc = await vpcOf('10.1.0.0/16')
    const foreign = await groupOf(otherVpc, 'foreign')
    expect(error(await authorize(permission(1, { protocol: '-1', group: foreign }))).code).toBe('InvalidGroup.NotFound')

    await call('DeleteSecurityGroup', { GroupId: foreign })
    await call('DeleteVpc', { VpcId: otherVpc })
    await call('DeleteSecurityGroup', { GroupId: group })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('limits the number of rules per direction', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const group = await groupOf(vpc, 'busy')
    for (let i = 1; i <= 60; i++) {
      expect((await call('AuthorizeSecurityGroupIngress', { GroupId: group, ...permission(1, { protocol: 'tcp', from: i, to: i, cidr: '10.0.0.0/8' }) })).status).toBe(200)
    }
    expect(error(await call('AuthorizeSecurityGroupIngress', { GroupId: group, ...permission(1, { protocol: 'tcp', from: 61, to: 61, cidr: '10.0.0.0/8' }) })))
      .toMatchObject({ code: 'RulesPerSecurityGroupLimitExceeded' })
    // egress has its own budget
    expect((await call('AuthorizeSecurityGroupEgress', { GroupId: group, ...permission(1, { protocol: 'tcp', from: 1, to: 1, cidr: '10.0.0.0/8' }) })).status).toBe(200)
    // and so does IPv6: the quota is counted separately per IP family
    for (let i = 1; i <= 60; i++) {
      expect((await call('AuthorizeSecurityGroupIngress', { GroupId: group, ...permission(1, { protocol: 'tcp', from: i, to: i, cidr6: '::/0' }) })).status).toBe(200)
    }
    expect(error(await call('AuthorizeSecurityGroupIngress', { GroupId: group, ...permission(1, { protocol: 'tcp', from: 61, to: 61, cidr6: '::/0' }) })))
      .toMatchObject({ code: 'RulesPerSecurityGroupLimitExceeded' })
    await call('DeleteSecurityGroup', { GroupId: group })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('revokes rules by specification or by rule ID', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const group = await groupOf(vpc, 'revoking')
    await call('AuthorizeSecurityGroupIngress', {
      GroupId: group,
      ...permission(1, { protocol: 'tcp', from: 22, to: 22, cidr: '10.0.0.0/8', description: 'ssh' }),
      ...permission(2, { protocol: 'tcp', from: 80, to: 80, cidr: '10.0.0.0/8' }),
      ...permission(3, { protocol: 'tcp', from: 443, to: 443, cidr: '10.0.0.0/8' }),
    })
    const [ssh, , https] = await rulesOfGroup(group).then(rules => rules.filter(r => r.isEgress === 'false'))

    // the description does not have to match
    const bySpec = (await call('RevokeSecurityGroupIngress', { GroupId: group, ...permission(1, { protocol: 'tcp', from: 22, to: 22, cidr: '10.0.0.0/8' }) })).body.RevokeSecurityGroupIngressResponse
    expect(bySpec.return).toBe('true')
    expect(items(bySpec.revokedSecurityGroupRuleSet).map(r => r.securityGroupRuleId)).toEqual([ssh.securityGroupRuleId])
    const byId = (await call('RevokeSecurityGroupIngress', { GroupId: group, 'SecurityGroupRuleId.1': https.securityGroupRuleId })).body.RevokeSecurityGroupIngressResponse
    expect(items(byId.revokedSecurityGroupRuleSet).map(r => r.securityGroupRuleId)).toEqual([https.securityGroupRuleId])
    expect((await rulesOfGroup(group)).filter(r => r.isEgress === 'false')).toHaveLength(1)

    // a non-default VPC rejects rules that do not exist, and revokes nothing
    expect(error(await call('RevokeSecurityGroupIngress', { GroupId: group, ...permission(1, { protocol: 'tcp', from: 80, to: 80, cidr: '10.0.0.0/8' }), ...permission(2, { protocol: 'tcp', from: 9, to: 9, cidr: '10.0.0.0/8' }) })))
      .toMatchObject({ code: 'InvalidPermission.NotFound' })
    expect((await rulesOfGroup(group)).filter(r => r.isEgress === 'false')).toHaveLength(1)
    expect(error(await call('RevokeSecurityGroupIngress', { GroupId: group, 'SecurityGroupRuleId.1': ssh.securityGroupRuleId }))).toMatchObject({ code: 'InvalidSecurityGroupRuleId.NotFound' })
    // the direction counts: the egress rule cannot be revoked as ingress
    const egressRule = (await rulesOfGroup(group)).find(r => r.isEgress === 'true')
    expect(error(await call('RevokeSecurityGroupIngress', { GroupId: group, 'SecurityGroupRuleId.1': egressRule.securityGroupRuleId }))).toMatchObject({ code: 'InvalidSecurityGroupRuleId.NotFound' })
    expect(error(await call('RevokeSecurityGroupIngress', { GroupId: group, 'SecurityGroupRuleId.1': egressRule.securityGroupRuleId, ...permission(1, { protocol: '-1', cidr: '0.0.0.0/0' }) })))
      .toMatchObject({ code: 'InvalidParameterCombination' })

    // the default egress rule is revoked like any other (Terraform does this when it manages the rules)
    const revokeEgress = await call('RevokeSecurityGroupEgress', { GroupId: group, ...permission(1, { protocol: '-1', cidr: '0.0.0.0/0' }) })
    expect(revokeEgress.status).toBe(200)
    expect((await rulesOfGroup(group)).filter(r => r.isEgress === 'true')).toHaveLength(0)

    // in the default VPC an unknown rule is reported, not an error
    const inDefault = (await call('CreateSecurityGroup', { GroupName: 'default-revoke', GroupDescription: 'd' })).body.CreateSecurityGroupResponse.groupId
    const unknown = (await call('RevokeSecurityGroupIngress', { GroupId: inDefault, ...permission(1, { protocol: 'tcp', from: 22, to: 22, cidr: '10.0.0.0/8' }) })).body.RevokeSecurityGroupIngressResponse
    expect(unknown.return).toBe('true')
    expect(items(unknown.unknownIpPermissionSet)).toMatchObject([{ ipProtocol: 'tcp', fromPort: '22', toPort: '22' }])
    await call('DeleteSecurityGroup', { GroupId: inDefault })

    await call('DeleteSecurityGroup', { GroupId: group })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('modifies rules in place and updates descriptions', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const group = await groupOf(vpc, 'editing')
    await call('AuthorizeSecurityGroupIngress', {
      GroupId: group,
      ...permission(1, { protocol: 'tcp', from: 22, to: 22, cidr: '10.0.0.0/8', description: 'ssh' }),
      ...permission(2, { protocol: 'tcp', from: 80, to: 80, cidr: '10.0.0.0/8' }),
    })
    const [ssh, http] = (await rulesOfGroup(group)).filter(r => r.isEgress === 'false')

    const modify = (id: string, rule: Record<string, string>) => call('ModifySecurityGroupRules', {
      GroupId: group,
      'SecurityGroupRule.1.SecurityGroupRuleId': id,
      ...Object.fromEntries(Object.entries(rule).map(([k, v]) => [`SecurityGroupRule.1.SecurityGroupRule.${k}`, v])),
    })
    expect((await modify(ssh.securityGroupRuleId, { IpProtocol: 'tcp', FromPort: '2222', ToPort: '2222', CidrIpv4: '172.16.0.0/12', Description: 'ssh2' })).body.ModifySecurityGroupRulesResponse.return).toBe('true')
    const changed = (await rulesOfGroup(group)).find(r => r.securityGroupRuleId === ssh.securityGroupRuleId)
    expect(changed).toMatchObject({ fromPort: '2222', toPort: '2222', cidrIpv4: '172.16.0.0/12', description: 'ssh2', isEgress: 'false' })

    expect(error(await modify(http.securityGroupRuleId, { IpProtocol: 'tcp', FromPort: '2222', ToPort: '2222', CidrIpv4: '172.16.0.0/12' }))).toMatchObject({ code: 'InvalidPermission.Duplicate' })
    expect(error(await modify(http.securityGroupRuleId, { IpProtocol: 'tcp', FromPort: '80', ToPort: '80' }))).toMatchObject({ code: 'InvalidPermission.Malformed' })
    expect(error(await modify('sgr-0123456789abcdef0', { IpProtocol: 'tcp', FromPort: '80', ToPort: '80', CidrIpv4: '10.0.0.0/8' }))).toMatchObject({ code: 'InvalidSecurityGroupRuleId.NotFound' })

    // descriptions by rule ID, by specification, and removal by omission
    expect((await call('UpdateSecurityGroupRuleDescriptionsIngress', {
      GroupId: group, 'SecurityGroupRuleDescription.1.SecurityGroupRuleId': http.securityGroupRuleId, 'SecurityGroupRuleDescription.1.Description': 'web',
    })).body.UpdateSecurityGroupRuleDescriptionsIngressResponse.return).toBe('true')
    expect((await rulesOfGroup(group)).find(r => r.securityGroupRuleId === http.securityGroupRuleId).description).toBe('web')
    await call('UpdateSecurityGroupRuleDescriptionsIngress', { GroupId: group, ...permission(1, { protocol: 'tcp', from: 80, to: 80, cidr: '10.0.0.0/8', description: 'http' }) })
    expect((await rulesOfGroup(group)).find(r => r.securityGroupRuleId === http.securityGroupRuleId).description).toBe('http')
    await call('UpdateSecurityGroupRuleDescriptionsIngress', { GroupId: group, ...permission(1, { protocol: 'tcp', from: 80, to: 80, cidr: '10.0.0.0/8' }) })
    expect((await rulesOfGroup(group)).find(r => r.securityGroupRuleId === http.securityGroupRuleId).description).toBeUndefined()
    expect(error(await call('UpdateSecurityGroupRuleDescriptionsIngress', { GroupId: group, ...permission(1, { protocol: 'tcp', from: 1, to: 1, cidr: '10.0.0.0/8' }) }))).toMatchObject({ code: 'InvalidPermission.NotFound' })
    expect(error(await call('UpdateSecurityGroupRuleDescriptionsEgress', { GroupId: group, 'SecurityGroupRuleDescription.1.SecurityGroupRuleId': http.securityGroupRuleId, 'SecurityGroupRuleDescription.1.Description': 'x' }))).toMatchObject({ code: 'InvalidSecurityGroupRuleId.NotFound' })

    await call('DeleteSecurityGroup', { GroupId: group })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('keeps groups alive while something depends on them, and removes their rules with them', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const app = await groupOf(vpc, 'app')
    const db = await groupOf(vpc, 'db')
    await call('AuthorizeSecurityGroupIngress', { GroupId: db, ...permission(1, { protocol: 'tcp', from: 5432, to: 5432, group: app }) })

    // referenced by a rule of another group
    expect(error(await call('DeleteSecurityGroup', { GroupId: app }))).toMatchObject({ code: 'DependencyViolation' })
    // the default group cannot be deleted
    const defaultGroup = items((await call('DescribeSecurityGroups', { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpc, 'Filter.2.Name': 'group-name', 'Filter.2.Value.1': 'default' })).body.DescribeSecurityGroupsResponse.securityGroupInfo)[0].groupId
    expect(error(await call('DeleteSecurityGroup', { GroupId: defaultGroup }))).toMatchObject({ code: 'CannotDelete' })
    // a group that only refers to itself is not kept alive by that rule
    await call('AuthorizeSecurityGroupIngress', { GroupId: db, ...permission(1, { protocol: 'tcp', from: 1, to: 1, group: db }) })

    // the VPC cannot go while custom groups exist
    expect(error(await call('DeleteVpc', { VpcId: vpc }))).toMatchObject({ code: 'DependencyViolation' })

    // a network interface that uses the group keeps it alive
    const { loadState, saveState } = require('@/app/api/data/ec2/state')
    const scope = { account: ACCOUNT, region: 'eu-west-1' }
    const state = loadState(scope)
    state.networkInterfaces['eni-0123456789abcdef0'] = { NetworkInterfaceId: 'eni-0123456789abcdef0', VpcId: vpc, SubnetId: 'subnet-x', Groups: [{ GroupId: db, GroupName: 'db' }], Tags: [] }
    saveState(scope, state)
    expect(error(await call('DeleteSecurityGroup', { GroupId: db }))).toMatchObject({ code: 'DependencyViolation' })
    const cleaned = loadState(scope)
    delete cleaned.networkInterfaces['eni-0123456789abcdef0']
    saveState(scope, cleaned)

    const ruleIds = (await rulesOfGroup(db)).map(r => r.securityGroupRuleId)
    expect(ruleIds.length).toBeGreaterThan(0)
    await call('RevokeSecurityGroupIngress', { GroupId: db, ...permission(1, { protocol: 'tcp', from: 5432, to: 5432, group: app }) })
    expect((await call('DeleteSecurityGroup', { GroupId: app })).status).toBe(200)
    expect((await call('DeleteSecurityGroup', { GroupId: db })).status).toBe(200)
    expect(await rulesOfGroup(db)).toHaveLength(0)
    for (const id of ruleIds) {
      expect(error(await call('DescribeSecurityGroupRules', { 'SecurityGroupRuleId.1': id }))).toMatchObject({ code: 'InvalidSecurityGroupRuleId.NotFound' })
    }

    // only the default group is left, and it goes with the VPC together with its rules
    const defaultRules = await rulesOfGroup(defaultGroup)
    expect(defaultRules).toHaveLength(2)
    expect((await call('DeleteVpc', { VpcId: vpc })).status).toBe(200)
    expect(await rulesOfGroup(defaultGroup)).toHaveLength(0)
  })

  it('does not change anything on DryRun', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const group = await groupOf(vpc, 'dry')
    const dry = await call('AuthorizeSecurityGroupIngress', { GroupId: group, DryRun: 'true', ...permission(1, { protocol: 'tcp', from: 22, to: 22, cidr: '10.0.0.0/8' }) })
    expect(error(dry)).toMatchObject({ status: 412, code: 'DryRunOperation' })
    expect(await rulesOfGroup(group).then(rules => rules.filter(r => r.isEgress === 'false'))).toHaveLength(0)
    expect(error(await call('DeleteSecurityGroup', { GroupId: group, DryRun: 'true' }))).toMatchObject({ code: 'DryRunOperation' })
    expect((await describeGroup(group)).groupId).toBe(group)
    await call('DeleteSecurityGroup', { GroupId: group })
    await call('DeleteVpc', { VpcId: vpc })
  })
})

const describeAcl = async (aclId: string) =>
  items((await call('DescribeNetworkAcls', { 'NetworkAclId.1': aclId })).body.DescribeNetworkAclsResponse.networkAclSet)[0]

interface EntryParams {
  RuleNumber: number
  Protocol: string
  RuleAction?: string
  Egress?: boolean
  CidrBlock?: string
  Ipv6CidrBlock?: string
  From?: number
  To?: number
  IcmpType?: number
  IcmpCode?: number
}

function entryParams(aclId: string, e: EntryParams): Record<string, string> {
  const params: Record<string, string> = {
    NetworkAclId: aclId, RuleNumber: String(e.RuleNumber), Protocol: e.Protocol, RuleAction: e.RuleAction ?? 'allow', Egress: String(e.Egress ?? false),
  }
  if (e.CidrBlock) params.CidrBlock = e.CidrBlock
  if (e.Ipv6CidrBlock) params.Ipv6CidrBlock = e.Ipv6CidrBlock
  if (e.From !== undefined) params['PortRange.From'] = String(e.From)
  if (e.To !== undefined) params['PortRange.To'] = String(e.To)
  if (e.IcmpType !== undefined) params['Icmp.Type'] = String(e.IcmpType)
  if (e.IcmpCode !== undefined) params['Icmp.Code'] = String(e.IcmpCode)
  return params
}

describe('ec2 network ACLs (phase 3)', () => {
  it('creates a custom ACL that only denies, lists it and deletes it', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const created = (await call('CreateNetworkAcl', {
      VpcId: vpc, 'TagSpecification.1.ResourceType': 'network-acl', 'TagSpecification.1.Tag.1.Key': 'Name', 'TagSpecification.1.Tag.1.Value': 'custom',
    })).body.CreateNetworkAclResponse.networkAcl
    expect(created.networkAclId).toMatch(/^acl-[0-9a-f]{17}$/)
    expect(created).toMatchObject({ vpcId: vpc, default: 'false', ownerId: ACCOUNT })
    expect(items(created.tagSet)).toEqual([{ key: 'Name', value: 'custom' }])
    expect(items(created.associationSet)).toHaveLength(0)
    expect(items(created.entrySet).map(e => [e.egress, e.ruleNumber, e.ruleAction, e.protocol, e.cidrBlock])).toEqual([
      ['true', '32767', 'deny', '-1', '0.0.0.0/0'],
      ['false', '32767', 'deny', '-1', '0.0.0.0/0'],
    ])

    const byVpc = items((await call('DescribeNetworkAcls', { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpc, 'Filter.2.Name': 'default', 'Filter.2.Value.1': 'false' })).body.DescribeNetworkAclsResponse.networkAclSet)
    expect(byVpc.map(a => a.networkAclId)).toEqual([created.networkAclId])

    expect(error(await call('CreateNetworkAcl', { VpcId: 'vpc-0123456789abcdef0' }))).toMatchObject({ code: 'InvalidVpcID.NotFound' })
    expect((await call('DeleteNetworkAcl', { NetworkAclId: created.networkAclId })).status).toBe(200)
    expect(error(await call('DescribeNetworkAcls', { 'NetworkAclId.1': created.networkAclId }))).toMatchObject({ code: 'InvalidNetworkAclID.NotFound' })
    expect(error(await call('DeleteNetworkAcl', { NetworkAclId: 'nope' }))).toMatchObject({ code: 'InvalidNetworkAclId.Malformed' })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('manages entries: create, replace, delete, ordering and validation', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const acl = (await call('CreateNetworkAcl', { VpcId: vpc })).body.CreateNetworkAclResponse.networkAcl.networkAclId
    const create = (e: EntryParams) => call('CreateNetworkAclEntry', entryParams(acl, e))

    expect((await create({ RuleNumber: 200, Protocol: 'tcp', From: 443, To: 443, CidrBlock: '10.0.0.0/8' })).status).toBe(200)
    expect((await create({ RuleNumber: 100, Protocol: '6', From: 22, To: 22, CidrBlock: '10.1.2.3/16' })).status).toBe(200)
    expect((await create({ RuleNumber: 100, Protocol: 'icmp', IcmpType: 8, IcmpCode: -1, CidrBlock: '0.0.0.0/0', Egress: true })).status).toBe(200)
    expect((await create({ RuleNumber: 110, Protocol: '-1', RuleAction: 'deny', Ipv6CidrBlock: '::/0' })).status).toBe(200)
    expect((await create({ RuleNumber: 120, Protocol: '47', CidrBlock: '0.0.0.0/0', From: 1, To: 2 })).status).toBe(200)

    const entries = items((await describeAcl(acl)).entrySet)
    expect(entries.map(e => `${e.egress === 'true' ? 'out' : 'in'}:${e.ruleNumber}`)).toEqual(['out:100', 'out:32767', 'in:100', 'in:110', 'in:120', 'in:200', 'in:32767'])
    expect(entries.find(e => e.egress === 'false' && e.ruleNumber === '100')).toMatchObject({ protocol: '6', cidrBlock: '10.1.0.0/16', portRange: { from: '22', to: '22' }, ruleAction: 'allow' })
    expect(entries.find(e => e.egress === 'true' && e.ruleNumber === '100')).toMatchObject({ protocol: '1', icmpTypeCode: { type: '8', code: '-1' } })
    expect(entries.find(e => e.ruleNumber === '110')).toMatchObject({ protocol: '-1', ruleAction: 'deny', ipv6CidrBlock: '::/0' })
    // ports are ignored for protocols other than TCP, UDP and ICMP
    expect(entries.find(e => e.ruleNumber === '120').portRange).toBeUndefined()

    const filtered = items((await call('DescribeNetworkAcls', { 'Filter.1.Name': 'entry.port-range.from', 'Filter.1.Value.1': '443', 'Filter.2.Name': 'entry.rule-action', 'Filter.2.Value.1': 'allow' })).body.DescribeNetworkAclsResponse.networkAclSet)
    expect(filtered.map(a => a.networkAclId)).toEqual([acl])

    expect(error(await create({ RuleNumber: 100, Protocol: 'tcp', From: 1, To: 1, CidrBlock: '10.0.0.0/8' }))).toMatchObject({ code: 'NetworkAclEntryAlreadyExists' })
    // ingress and egress have their own rule numbers; 32767 is reserved
    for (const RuleNumber of [0, 32767, 40000]) {
      expect(error(await create({ RuleNumber, Protocol: '-1', CidrBlock: '0.0.0.0/0' }))).toMatchObject({ code: 'InvalidParameterValue' })
    }
    expect(error(await create({ RuleNumber: 300, Protocol: 'tcp', CidrBlock: '10.0.0.0/8' })).code).toBe('InvalidParameterValue')
    expect(error(await create({ RuleNumber: 300, Protocol: 'tcp', From: 9, To: 1, CidrBlock: '10.0.0.0/8' })).code).toBe('InvalidParameterValue')
    expect(error(await create({ RuleNumber: 300, Protocol: 'icmp', CidrBlock: '10.0.0.0/8' })).code).toBe('InvalidParameterValue')
    expect(error(await create({ RuleNumber: 300, Protocol: 'bogus', CidrBlock: '10.0.0.0/8' })).code).toBe('InvalidParameterValue')
    expect(error(await create({ RuleNumber: 300, Protocol: '-1' })).code).toBe('InvalidParameterValue')
    expect(error(await create({ RuleNumber: 300, Protocol: '-1', CidrBlock: '10.0.0.0/8', Ipv6CidrBlock: '::/0' })).code).toBe('InvalidParameterValue')
    expect(error(await create({ RuleNumber: 300, Protocol: '-1', CidrBlock: '10.0.0.0/40' })).code).toBe('InvalidParameterValue')
    expect(error(await call('CreateNetworkAclEntry', { ...entryParams(acl, { RuleNumber: 300, Protocol: '-1', CidrBlock: '10.0.0.0/8' }), RuleAction: 'maybe' })).code).toBe('InvalidParameterValue')
    expect(error(await create({ RuleNumber: 300, Protocol: '-1', CidrBlock: '10.0.0.0/8' }).then(() => call('CreateNetworkAclEntry', { NetworkAclId: 'acl-0123456789abcdef0', RuleNumber: '1', Protocol: '-1', RuleAction: 'allow', Egress: 'false', CidrBlock: '10.0.0.0/8' }))).code).toBe('InvalidNetworkAclID.NotFound')

    // replace keeps the rule number and direction, and needs an existing entry
    expect((await call('ReplaceNetworkAclEntry', entryParams(acl, { RuleNumber: 200, Protocol: 'tcp', From: 8443, To: 8443, CidrBlock: '10.2.0.0/16', RuleAction: 'deny' }))).status).toBe(200)
    expect(items((await describeAcl(acl)).entrySet).find(e => e.egress === 'false' && e.ruleNumber === '200')).toMatchObject({ portRange: { from: '8443', to: '8443' }, cidrBlock: '10.2.0.0/16', ruleAction: 'deny' })
    expect(error(await call('ReplaceNetworkAclEntry', entryParams(acl, { RuleNumber: 250, Protocol: '-1', CidrBlock: '0.0.0.0/0' })))).toMatchObject({ code: 'InvalidNetworkAclEntry.NotFound' })
    expect(error(await call('ReplaceNetworkAclEntry', entryParams(acl, { RuleNumber: 200, Protocol: '-1', CidrBlock: '0.0.0.0/0', Egress: true })))).toMatchObject({ code: 'InvalidNetworkAclEntry.NotFound' })

    expect((await call('DeleteNetworkAclEntry', { NetworkAclId: acl, RuleNumber: '200', Egress: 'false' })).status).toBe(200)
    expect(error(await call('DeleteNetworkAclEntry', { NetworkAclId: acl, RuleNumber: '200', Egress: 'false' }))).toMatchObject({ code: 'InvalidNetworkAclEntry.NotFound' })
    expect(error(await call('DeleteNetworkAclEntry', { NetworkAclId: acl, RuleNumber: '32767', Egress: 'false' }))).toMatchObject({ code: 'InvalidParameterValue' })
    expect(items((await describeAcl(acl)).entrySet).some(e => e.ruleNumber === '32767' && e.egress === 'false')).toBe(true)

    await call('DeleteNetworkAcl', { NetworkAclId: acl })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('limits the number of entries per direction', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const acl = (await call('CreateNetworkAcl', { VpcId: vpc })).body.CreateNetworkAclResponse.networkAcl.networkAclId
    for (let i = 1; i <= 20; i++) {
      expect((await call('CreateNetworkAclEntry', entryParams(acl, { RuleNumber: i, Protocol: '-1', CidrBlock: '10.0.0.0/8' }))).status).toBe(200)
    }
    expect(error(await call('CreateNetworkAclEntry', entryParams(acl, { RuleNumber: 21, Protocol: '-1', CidrBlock: '10.0.0.0/8' })))).toMatchObject({ code: 'NetworkAclEntryLimitExceeded' })
    expect((await call('CreateNetworkAclEntry', entryParams(acl, { RuleNumber: 1, Protocol: '-1', CidrBlock: '10.0.0.0/8', Egress: true }))).status).toBe(200)
    await call('DeleteNetworkAcl', { NetworkAclId: acl })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('moves subnets between ACLs and protects ACLs that are in use', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const subnet = (await call('CreateSubnet', { VpcId: vpc, CidrBlock: '10.0.1.0/24', AvailabilityZone: 'eu-west-1a' })).body.CreateSubnetResponse.subnet.subnetId
    const defaultAcl = items((await call('DescribeNetworkAcls', { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpc })).body.DescribeNetworkAclsResponse.networkAclSet)[0]
    const association = items(defaultAcl.associationSet).find(a => a.subnetId === subnet).networkAclAssociationId
    const custom = (await call('CreateNetworkAcl', { VpcId: vpc })).body.CreateNetworkAclResponse.networkAcl.networkAclId

    const moved = (await call('ReplaceNetworkAclAssociation', { AssociationId: association, NetworkAclId: custom })).body.ReplaceNetworkAclAssociationResponse.newAssociationId
    expect(moved).toMatch(/^aclassoc-[0-9a-f]{17}$/)
    expect(moved).not.toBe(association)
    expect(items((await describeAcl(custom)).associationSet)).toMatchObject([{ networkAclAssociationId: moved, networkAclId: custom, subnetId: subnet }])
    expect(items((await describeAcl(defaultAcl.networkAclId)).associationSet).some(a => a.subnetId === subnet)).toBe(false)
    const bySubnet = items((await call('DescribeNetworkAcls', { 'Filter.1.Name': 'association.subnet-id', 'Filter.1.Value.1': subnet })).body.DescribeNetworkAclsResponse.networkAclSet)
    expect(bySubnet.map(a => a.networkAclId)).toEqual([custom])

    // moving to the ACL it already has is a no-op
    expect((await call('ReplaceNetworkAclAssociation', { AssociationId: moved, NetworkAclId: custom })).body.ReplaceNetworkAclAssociationResponse.newAssociationId).toBe(moved)
    expect(error(await call('ReplaceNetworkAclAssociation', { AssociationId: association, NetworkAclId: custom }))).toMatchObject({ code: 'InvalidAssociationID.NotFound' })
    expect(error(await call('ReplaceNetworkAclAssociation', { AssociationId: moved, NetworkAclId: 'acl-0123456789abcdef0' }))).toMatchObject({ code: 'InvalidNetworkAclID.NotFound' })

    // an ACL of another VPC cannot be used
    const otherVpc = await vpcOf('10.1.0.0/16')
    const foreign = (await call('CreateNetworkAcl', { VpcId: otherVpc })).body.CreateNetworkAclResponse.networkAcl.networkAclId
    expect(error(await call('ReplaceNetworkAclAssociation', { AssociationId: moved, NetworkAclId: foreign }))).toMatchObject({ code: 'InvalidParameterValue' })

    // lifetime: in use, the default ACL and ACLs of a VPC cannot be deleted; the VPC cannot go either
    expect(error(await call('DeleteNetworkAcl', { NetworkAclId: custom }))).toMatchObject({ code: 'DependencyViolation' })
    expect(error(await call('DeleteNetworkAcl', { NetworkAclId: defaultAcl.networkAclId }))).toMatchObject({ code: 'InvalidParameterValue' })
    expect(error(await call('DeleteVpc', { VpcId: vpc }))).toMatchObject({ code: 'DependencyViolation' })

    // deleting the subnet drops its association, which frees the ACL
    expect((await call('DeleteSubnet', { SubnetId: subnet })).status).toBe(200)
    expect(items((await describeAcl(custom)).associationSet)).toHaveLength(0)
    expect((await call('DeleteNetworkAcl', { NetworkAclId: custom })).status).toBe(200)
    expect((await call('DeleteVpc', { VpcId: vpc })).status).toBe(200)
    // the default ACL went with the VPC
    expect(error(await call('DescribeNetworkAcls', { 'NetworkAclId.1': defaultAcl.networkAclId }))).toMatchObject({ code: 'InvalidNetworkAclID.NotFound' })

    await call('DeleteNetworkAcl', { NetworkAclId: foreign })
    await call('DeleteVpc', { VpcId: otherVpc })
  })

  it('does not change anything on DryRun', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    expect(error(await call('CreateNetworkAcl', { VpcId: vpc, DryRun: 'true' }))).toMatchObject({ status: 412, code: 'DryRunOperation' })
    const acls = items((await call('DescribeNetworkAcls', { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpc })).body.DescribeNetworkAclsResponse.networkAclSet)
    expect(acls).toHaveLength(1)
    expect(acls[0].default).toBe('true')
    await call('DeleteVpc', { VpcId: vpc })
  })
})

describe('ec2 quotas of the account', () => {
  const { QUOTAS, setQuota, resetQuota } = require('@/app/api/quotas')
  const scope = (region = 'eu-west-1') => ({ account: ACCOUNT, region })

  // The quota is lowered for one account and region and always put back, so other tests keep the defaults.
  async function withQuota(key: string, value: number, run: () => Promise<void>, region = 'eu-west-1') {
    setQuota(scope(region), key, value)
    try {
      await run()
    } finally {
      resetQuota(scope(region), key)
    }
  }

  it('limits VPCs per Region to the quota of the account, per region', async () => {
    const existing = items((await call('DescribeVpcs')).body.DescribeVpcsResponse.vpcSet).length // the default VPC counts
    await withQuota(QUOTAS.vpcsPerRegion, existing + 1, async () => {
      const vpc = await vpcOf('10.0.0.0/16')
      expect(error(await createVpc('10.1.0.0/16'))).toMatchObject({ code: 'VpcLimitExceeded' })
      // another region has its own quota, and its own default VPC
      expect((await call('CreateVpc', { CidrBlock: '10.1.0.0/16' }, 'eu-central-1')).status).toBe(200)
      const other = items((await call('DescribeVpcs', { 'Filter.1.Name': 'cidr', 'Filter.1.Value.1': '10.1.0.0/16' }, 'eu-central-1')).body.DescribeVpcsResponse.vpcSet)[0].vpcId
      await call('DeleteVpc', { VpcId: other }, 'eu-central-1')
      await call('DeleteVpc', { VpcId: vpc })
    })
    // raising it is what an approved quota increase does
    await withQuota(QUOTAS.vpcsPerRegion, existing + 2, async () => {
      const first = await vpcOf('10.0.0.0/16')
      const second = await vpcOf('10.1.0.0/16')
      expect(error(await createVpc('10.2.0.0/16'))).toMatchObject({ code: 'VpcLimitExceeded' })
      await call('DeleteVpc', { VpcId: first })
      await call('DeleteVpc', { VpcId: second })
    })
  })

  it('limits subnets per VPC, network ACLs per VPC and CIDR blocks per VPC', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    await withQuota(QUOTAS.subnetsPerVpc, 2, async () => {
      const a = (await call('CreateSubnet', { VpcId: vpc, CidrBlock: '10.0.1.0/24' })).body.CreateSubnetResponse.subnet.subnetId
      const b = (await call('CreateSubnet', { VpcId: vpc, CidrBlock: '10.0.2.0/24' })).body.CreateSubnetResponse.subnet.subnetId
      expect(error(await call('CreateSubnet', { VpcId: vpc, CidrBlock: '10.0.3.0/24' }))).toMatchObject({ code: 'SubnetLimitExceeded' })
      await call('DeleteSubnet', { SubnetId: a })
      await call('DeleteSubnet', { SubnetId: b })
    })
    await withQuota(QUOTAS.networkAclsPerVpc, 2, async () => {
      // the default ACL counts
      const acl = (await call('CreateNetworkAcl', { VpcId: vpc })).body.CreateNetworkAclResponse.networkAcl.networkAclId
      expect(error(await call('CreateNetworkAcl', { VpcId: vpc }))).toMatchObject({ code: 'NetworkAclLimitExceeded' })
      await call('DeleteNetworkAcl', { NetworkAclId: acl })
    })
    await withQuota(QUOTAS.ipv4CidrBlocksPerVpc, 2, async () => {
      expect((await call('AssociateVpcCidrBlock', { VpcId: vpc, CidrBlock: '10.1.0.0/16' })).status).toBe(200)
      expect(error(await call('AssociateVpcCidrBlock', { VpcId: vpc, CidrBlock: '10.2.0.0/16' }))).toMatchObject({ code: 'CidrLimitExceeded' })
    })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('limits security groups per Region and rules per security group and network ACL', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const groups = Object.keys(require('@/app/api/data/ec2/state').loadState(scope()).securityGroups).length
    await withQuota(QUOTAS.securityGroupsPerRegion, groups + 1, async () => {
      const group = await groupOf(vpc, 'only-one-more')
      expect(error(await call('CreateSecurityGroup', { GroupName: 'one-too-many', GroupDescription: 'd', VpcId: vpc }))).toMatchObject({ code: 'SecurityGroupLimitExceeded' })
      await call('DeleteSecurityGroup', { GroupId: group })
    })
    const group = await groupOf(vpc, 'few-rules')
    await withQuota(QUOTAS.rulesPerSecurityGroup, 2, async () => {
      for (const port of [1, 2]) {
        expect((await call('AuthorizeSecurityGroupIngress', { GroupId: group, ...permission(1, { protocol: 'tcp', from: port, to: port, cidr: '10.0.0.0/8' }) })).status).toBe(200)
      }
      expect(error(await call('AuthorizeSecurityGroupIngress', { GroupId: group, ...permission(1, { protocol: 'tcp', from: 3, to: 3, cidr: '10.0.0.0/8' }) })))
        .toMatchObject({ code: 'RulesPerSecurityGroupLimitExceeded' })
      // a request that goes over the quota adds none of its rules
      expect(error(await call('AuthorizeSecurityGroupIngress', { GroupId: group, ...permission(1, { protocol: 'tcp', from: 4, to: 4, cidr6: '::/0' }), ...permission(2, { protocol: 'tcp', from: 5, to: 5, cidr6: '::/0' }), ...permission(3, { protocol: 'tcp', from: 6, to: 6, cidr6: '::/0' }) })))
        .toMatchObject({ code: 'RulesPerSecurityGroupLimitExceeded' })
      expect((await rulesOfGroup(group)).filter(r => r.isEgress === 'false')).toHaveLength(2)
    })
    await call('DeleteSecurityGroup', { GroupId: group })

    const acl = (await call('CreateNetworkAcl', { VpcId: vpc })).body.CreateNetworkAclResponse.networkAcl.networkAclId
    await withQuota(QUOTAS.rulesPerNetworkAcl, 1, async () => {
      expect((await call('CreateNetworkAclEntry', entryParams(acl, { RuleNumber: 100, Protocol: '-1', CidrBlock: '10.0.0.0/8' }))).status).toBe(200)
      expect(error(await call('CreateNetworkAclEntry', entryParams(acl, { RuleNumber: 110, Protocol: '-1', CidrBlock: '10.0.0.0/8' })))).toMatchObject({ code: 'NetworkAclEntryLimitExceeded' })
    })
    await call('DeleteNetworkAcl', { NetworkAclId: acl })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('keeps the tag limit that no account can change', async () => {
    const tags = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v']))
    expect(error(await createVpc('10.0.0.0/16', tags))).toMatchObject({ code: 'TagLimitExceeded' })
  })
})

// ---------------------------------------------------------------------------
// phase 4 (partial): Elastic IPs and NAT gateways
// ---------------------------------------------------------------------------

const { QUOTAS: Q4, setQuota: setQuota4, resetQuota: resetQuota4 } = require('@/app/api/quotas')
const { loadState: loadState4, saveState: saveState4 } = require('@/app/api/data/ec2/state')

const tagSpec = (type: string, key: string, value: string) =>
  ({ 'TagSpecification.1.ResourceType': type, 'TagSpecification.1.Tag.1.Key': key, 'TagSpecification.1.Tag.1.Value': value })
const allocate = async (extra: Record<string, string> = {}) => (await call('AllocateAddress', { Domain: 'vpc', ...extra })).body.AllocateAddressResponse
const inAzSubnet = async (vpc: string, cidr: string, az = 'eu-west-1a') =>
  (await call('CreateSubnet', { VpcId: vpc, CidrBlock: cidr, AvailabilityZone: az })).body.CreateSubnetResponse.subnet.subnetId as string
const describeNat = async (id: string) => items((await call('DescribeNatGateways', { 'NatGatewayId.1': id })).body.DescribeNatGatewaysResponse.natGatewaySet)[0]
const subnetFree = async (id: string) => Number(items((await call('DescribeSubnets', { 'SubnetId.1': id })).body.DescribeSubnetsResponse.subnetSet)[0].availableIpAddressCount)
const eniOf = async (id: string) => items((await call('DescribeNetworkInterfaces', { 'NetworkInterfaceId.1': id })).body.DescribeNetworkInterfacesResponse.networkInterfaceSet)[0]

describe('ec2 Elastic IP addresses (phase 4, partial)', () => {
  it('allocates, describes, tags and releases addresses', async () => {
    const created = await allocate(tagSpec('elastic-ip', 'Name', 'nat-ip'))
    expect(created).toMatchObject({ domain: 'vpc', publicIpv4Pool: 'amazon', networkBorderGroup: 'eu-west-1' })
    expect(created.allocationId).toMatch(/^eipalloc-[0-9a-f]{17}$/)
    expect(created.publicIp).toMatch(/^198\.1[89]\.\d+\.\d+$/)

    const byId = items((await call('DescribeAddresses', { 'AllocationId.1': created.allocationId })).body.DescribeAddressesResponse.addressesSet)
    expect(byId).toHaveLength(1)
    expect(byId[0]).toMatchObject({ allocationId: created.allocationId, publicIp: created.publicIp, domain: 'vpc' })
    expect(items(byId[0].tagSet)).toEqual([{ key: 'Name', value: 'nat-ip' }])
    const filter = (name: string, value: string) => call('DescribeAddresses', { 'Filter.1.Name': name, 'Filter.1.Value.1': value })
    expect(items((await filter('public-ip', created.publicIp)).body.DescribeAddressesResponse.addressesSet).map(a => a.allocationId)).toEqual([created.allocationId])
    expect(items((await filter('tag:Name', 'nat-ip')).body.DescribeAddressesResponse.addressesSet).map(a => a.allocationId)).toEqual([created.allocationId])
    expect(items((await call('DescribeAddresses', { 'PublicIp.1': created.publicIp })).body.DescribeAddressesResponse.addressesSet)).toHaveLength(1)
    expect(error(await call('DescribeAddresses', { 'PublicIp.1': '198.18.0.1' }))).toMatchObject({ code: 'InvalidAddress.NotFound' })
    expect(error(await call('DescribeAddresses', { 'AllocationId.1': 'eipalloc-0123456789abcdef0' }))).toMatchObject({ code: 'InvalidAllocationID.NotFound' })
    expect(error(await call('DescribeAddresses', { 'AllocationId.1': 'nope' }))).toMatchObject({ code: 'InvalidAllocationID.Malformed' })

    expect((await call('ReleaseAddress', { AllocationId: created.allocationId, NetworkBorderGroup: 'eu-west-1' })).status).toBe(200) // the Terraform provider sends the border group
    expect(error(await call('ReleaseAddress', { AllocationId: created.allocationId }))).toMatchObject({ code: 'InvalidAllocationID.NotFound' })
    expect(error(await call('ReleaseAddress', {}))).toMatchObject({ code: 'MissingParameter' })
    const other = await allocate()
    expect(error(await call('ReleaseAddress', { AllocationId: other.allocationId, NetworkBorderGroup: 'us-east-1' }))).toMatchObject({ code: 'InvalidParameterValue' })
    await call('ReleaseAddress', { AllocationId: other.allocationId })
  })

  it('rejects what is not supported yet by name, and respects the quota of the account', async () => {
    expect(error(await call('AllocateAddress', { Domain: 'standard' }))).toMatchObject({ code: 'InvalidParameterValue' })
    expect(error(await call('AllocateAddress', { Address: '203.0.113.5' }))).toMatchObject({ code: 'UnsupportedOperation', message: expect.stringContaining('Address') })
    expect(error(await call('AllocateAddress', { CustomerOwnedIpv4Pool: 'pool' }))).toMatchObject({ code: 'UnsupportedOperation' })

    const held = Object.keys(loadState4({ account: ACCOUNT, region: 'eu-west-1' }).addresses).length
    setQuota4({ account: ACCOUNT, region: 'eu-west-1' }, Q4.elasticIpsPerRegion, held + 1)
    try {
      const only = await allocate()
      expect(error(await call('AllocateAddress', {}))).toMatchObject({ code: 'AddressLimitExceeded' })
      await call('ReleaseAddress', { AllocationId: only.allocationId })
      expect((await call('AllocateAddress', {})).status).toBe(200) // released addresses free the quota
    } finally {
      resetQuota4({ account: ACCOUNT, region: 'eu-west-1' }, Q4.elasticIpsPerRegion)
      const state = loadState4({ account: ACCOUNT, region: 'eu-west-1' })
      state.addresses = {}
      saveState4({ account: ACCOUNT, region: 'eu-west-1' }, state)
    }
  })
})

describe('ec2 NAT gateways (phase 4, partial)', () => {
  it('creates a public NAT gateway with its interface and Elastic IP, and gives them back when deleted', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const subnet = await inAzSubnet(vpc, '10.0.1.0/24')
    const igw = (await call('CreateInternetGateway')).body.CreateInternetGatewayResponse.internetGateway.internetGatewayId
    await call('AttachInternetGateway', { InternetGatewayId: igw, VpcId: vpc })
    const eip = await allocate()
    expect(await subnetFree(subnet)).toBe(251)

    const created = (await call('CreateNatGateway', { SubnetId: subnet, AllocationId: eip.allocationId, ClientToken: 'tok', ...tagSpec('natgateway', 'Name', 'main') })).body.CreateNatGatewayResponse
    expect(created.clientToken).toBe('tok')
    const nat = created.natGateway
    expect(nat).toMatchObject({ vpcId: vpc, subnetId: subnet, state: 'available', connectivityType: 'public' })
    expect(nat.natGatewayId).toMatch(/^nat-[0-9a-f]{17}$/)
    expect(items(nat.tagSet)).toEqual([{ key: 'Name', value: 'main' }])
    const address = items(nat.natGatewayAddressSet)[0]
    expect(address).toMatchObject({ allocationId: eip.allocationId, publicIp: eip.publicIp, privateIp: '10.0.1.4', isPrimary: 'true', status: 'succeeded' })

    // the interface of the NAT gateway is requester-managed and uses the first free address of the subnet
    const eni = await eniOf(address.networkInterfaceId)
    expect(eni).toMatchObject({
      description: `Interface for NAT Gateway ${nat.natGatewayId}`, requesterManaged: 'true', interfaceType: 'nat_gateway',
      privateIpAddress: '10.0.1.4', subnetId: subnet, vpcId: vpc, sourceDestCheck: 'false',
    })
    expect(eni.association).toMatchObject({ publicIp: eip.publicIp, allocationId: eip.allocationId })
    expect(await subnetFree(subnet)).toBe(250)
    // and the Elastic IP is associated with it
    const associated = items((await call('DescribeAddresses', { 'AllocationId.1': eip.allocationId })).body.DescribeAddressesResponse.addressesSet)[0]
    expect(associated).toMatchObject({ networkInterfaceId: address.networkInterfaceId, privateIpAddress: '10.0.1.4' })
    expect(associated.associationId).toBe(address.associationId)

    // filters, and the filter parameter of this operation is called Filter
    const found = async (name: string, value: string) =>
      items((await call('DescribeNatGateways', { 'Filter.1.Name': name, 'Filter.1.Value.1': value })).body.DescribeNatGatewaysResponse.natGatewaySet).map(n => n.natGatewayId)
    for (const [name, value] of [['state', 'available'], ['subnet-id', subnet], ['vpc-id', vpc], ['nat-gateway-id', nat.natGatewayId], ['tag:Name', 'main']]) {
      expect(await found(name, value)).toEqual([nat.natGatewayId])
    }
    expect(await found('state', 'deleted')).toEqual([])
    expect(items((await call('DescribeTags', { 'Filter.1.Name': 'resource-id', 'Filter.1.Value.1': nat.natGatewayId })).body.DescribeTagsResponse.tagSet)[0]).toMatchObject({ resourceType: 'natgateway', key: 'Name' })

    // what the NAT gateway holds cannot be removed under it
    expect(error(await call('DeleteSubnet', { SubnetId: subnet }))).toMatchObject({ code: 'DependencyViolation' })
    expect(error(await call('DetachInternetGateway', { InternetGatewayId: igw, VpcId: vpc }))).toMatchObject({ code: 'DependencyViolation', message: expect.stringContaining('mapped public address') })
    expect(error(await call('ReleaseAddress', { AllocationId: eip.allocationId }))).toMatchObject({ code: 'InvalidIPAddress.InUse' })
    // an address held by a NAT gateway cannot be taken from it; an association that is gone is not found
    expect(error(await call('DisassociateAddress', { AssociationId: address.associationId }))).toMatchObject({ code: 'OperationNotPermitted' })
    expect(error(await call('DisassociateAddress', { AssociationId: 'eipassoc-0123456789abcdef0' }))).toMatchObject({ code: 'InvalidAssociationID.NotFound' })
    expect(error(await call('DisassociateAddress', {}))).toMatchObject({ code: 'MissingParameter' })
    expect(error(await call('DeleteVpc', { VpcId: vpc }))).toMatchObject({ code: 'DependencyViolation' })
    const second = await inAzSubnet(vpc, '10.0.2.0/24')
    expect(error(await call('CreateNatGateway', { SubnetId: second, AllocationId: eip.allocationId }))).toMatchObject({ code: 'Resource.AlreadyAssociated' })
    expect(await subnetFree(second)).toBe(251) // the failed create left nothing behind

    // delete: the interface and the address go back, the NAT gateway stays visible as deleted
    const removed = (await call('DeleteNatGateway', { NatGatewayId: nat.natGatewayId })).body.DeleteNatGatewayResponse
    expect(removed.natGatewayId).toBe(nat.natGatewayId)
    const gone = await describeNat(nat.natGatewayId)
    expect(gone.state).toBe('deleted')
    expect(gone.deleteTime).toBeDefined()
    expect(await found('state', 'deleted')).toEqual([nat.natGatewayId])
    expect(error(await call('DescribeNetworkInterfaces', { 'NetworkInterfaceId.1': address.networkInterfaceId }))).toMatchObject({ code: 'InvalidNetworkInterfaceID.NotFound' })
    expect(await subnetFree(subnet)).toBe(251)
    const freed = items((await call('DescribeAddresses', { 'AllocationId.1': eip.allocationId })).body.DescribeAddressesResponse.addressesSet)[0]
    expect(freed.associationId).toBeUndefined()
    expect(freed.networkInterfaceId).toBeUndefined()
    // Terraform still has the old association id when it destroys the address after the NAT gateway
    expect(error(await call('DisassociateAddress', { AssociationId: address.associationId }))).toMatchObject({ code: 'InvalidAssociationID.NotFound' })
    expect((await call('DeleteNatGateway', { NatGatewayId: nat.natGatewayId })).status).toBe(200) // already deleted: nothing to do

    expect((await call('ReleaseAddress', { AllocationId: eip.allocationId })).status).toBe(200)
    expect((await call('DetachInternetGateway', { InternetGatewayId: igw, VpcId: vpc })).status).toBe(200)
    await call('DeleteInternetGateway', { InternetGatewayId: igw })
    await call('DeleteSubnet', { SubnetId: second })
    expect((await call('DeleteSubnet', { SubnetId: subnet })).status).toBe(200)
    expect((await call('DeleteVpc', { VpcId: vpc })).status).toBe(200)
  })

  it('derives the state of a route from its NAT gateway', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const subnet = await inAzSubnet(vpc, '10.0.1.0/24')
    const eip = await allocate()
    const nat = (await call('CreateNatGateway', { SubnetId: subnet, AllocationId: eip.allocationId })).body.CreateNatGatewayResponse.natGateway.natGatewayId
    const rtb = (await call('CreateRouteTable', { VpcId: vpc })).body.CreateRouteTableResponse.routeTable.routeTableId
    const routeState = async () => items(items((await call('DescribeRouteTables', { 'RouteTableId.1': rtb })).body.DescribeRouteTablesResponse.routeTableSet)[0].routeSet)
      .find(r => r.destinationCidrBlock === '0.0.0.0/0')?.state

    expect(error(await call('CreateRoute', { RouteTableId: rtb, DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-0123456789abcdef0' }))).toMatchObject({ code: 'InvalidNatGatewayID.NotFound' })
    expect((await call('CreateRoute', { RouteTableId: rtb, DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: nat })).status).toBe(200)
    expect(await routeState()).toBe('active')
    const byState = (state: string) => call('DescribeRouteTables', { 'Filter.1.Name': 'route.state', 'Filter.1.Value.1': state, 'Filter.2.Name': 'route-table-id', 'Filter.2.Value.1': rtb })
    expect(items((await byState('active')).body.DescribeRouteTablesResponse.routeTableSet)).toHaveLength(1)

    await call('DeleteNatGateway', { NatGatewayId: nat })
    // nobody touched the route; its state follows its target
    expect(await routeState()).toBe('blackhole')
    expect(items((await byState('blackhole')).body.DescribeRouteTablesResponse.routeTableSet)).toHaveLength(1)
    expect(error(await call('ReplaceRoute', { RouteTableId: rtb, DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: nat }))).toMatchObject({ code: 'InvalidNatGatewayID.NotFound' })

    // an internet gateway that is detached makes its routes blackholes too
    const igw = (await call('CreateInternetGateway')).body.CreateInternetGatewayResponse.internetGateway.internetGatewayId
    await call('AttachInternetGateway', { InternetGatewayId: igw, VpcId: vpc })
    await call('ReplaceRoute', { RouteTableId: rtb, DestinationCidrBlock: '0.0.0.0/0', GatewayId: igw })
    expect(await routeState()).toBe('active')
    await call('DetachInternetGateway', { InternetGatewayId: igw, VpcId: vpc })
    expect(await routeState()).toBe('blackhole')

    await call('DeleteInternetGateway', { InternetGatewayId: igw })
    await call('DeleteRoute', { RouteTableId: rtb, DestinationCidrBlock: '0.0.0.0/0' })
    await call('DeleteRouteTable', { RouteTableId: rtb })
    await call('ReleaseAddress', { AllocationId: eip.allocationId })
    await call('DeleteSubnet', { SubnetId: subnet })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('validates the parameters and rejects what is not supported yet', async () => {
    const vpc = await vpcOf('10.0.0.0/16')
    const subnet = await inAzSubnet(vpc, '10.0.1.0/24')
    const eip = await allocate()
    expect(error(await call('CreateNatGateway', { SubnetId: subnet }))).toMatchObject({ code: 'MissingParameter' })
    expect(error(await call('CreateNatGateway', { AllocationId: eip.allocationId }))).toMatchObject({ code: 'MissingParameter' })
    expect(error(await call('CreateNatGateway', { SubnetId: subnet, AllocationId: 'eipalloc-0123456789abcdef0' }))).toMatchObject({ code: 'InvalidAllocationID.NotFound' })
    expect(error(await call('CreateNatGateway', { SubnetId: 'subnet-0123456789abcdef0', AllocationId: eip.allocationId }))).toMatchObject({ code: 'InvalidSubnetID.NotFound' })
    expect(error(await call('CreateNatGateway', { SubnetId: subnet, AllocationId: eip.allocationId, ConnectivityType: 'private' }))).toMatchObject({ code: 'InvalidParameterCombination' })
    expect(error(await call('CreateNatGateway', { SubnetId: subnet, AllocationId: eip.allocationId, 'SecondaryAllocationId.1': eip.allocationId })))
      .toMatchObject({ code: 'UnsupportedOperation', message: expect.stringContaining('SecondaryAllocationIds') })
    expect(error(await call('CreateNatGateway', { SubnetId: subnet, AllocationId: eip.allocationId, PrivateIpAddress: '10.0.1.50' }))).toMatchObject({ code: 'UnsupportedOperation' })
    expect(error(await call('DescribeNatGateways', { 'NatGatewayId.1': 'nat-0123456789abcdef0' }))).toMatchObject({ code: 'NatGatewayNotFound' })
    expect(error(await call('DescribeNatGateways', { 'NatGatewayId.1': 'bad' }))).toMatchObject({ code: 'NatGatewayMalformed' })
    expect(error(await call('DeleteNatGateway', { NatGatewayId: 'nat-0123456789abcdef0' }))).toMatchObject({ code: 'NatGatewayNotFound' })
    expect(items((await call('DescribeNatGateways', { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpc })).body.DescribeNatGatewaysResponse.natGatewaySet)).toHaveLength(0)
    expect(await subnetFree(subnet)).toBe(251)

    // a private NAT gateway has an interface and no address
    const priv = (await call('CreateNatGateway', { SubnetId: subnet, ConnectivityType: 'private' })).body.CreateNatGatewayResponse.natGateway
    expect(priv.connectivityType).toBe('private')
    expect(items(priv.natGatewayAddressSet)[0]).toMatchObject({ privateIp: '10.0.1.4' })
    expect(items(priv.natGatewayAddressSet)[0].publicIp).toBeUndefined()
    expect((await call('DeleteNatGateway', { NatGatewayId: priv.natGatewayId })).status).toBe(200)
    expect((await describeNat(priv.natGatewayId)).state).toBe('deleted')
    expect(await subnetFree(subnet)).toBe(251)

    await call('ReleaseAddress', { AllocationId: eip.allocationId })
    await call('DeleteSubnet', { SubnetId: subnet })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('limits NAT gateways per Availability Zone and network interfaces per Region, and counts only live NAT gateways', async () => {
    const scope = { account: ACCOUNT, region: 'eu-west-1' }
    const vpc = await vpcOf('10.0.0.0/16')
    const a1 = await inAzSubnet(vpc, '10.0.1.0/24', 'eu-west-1a')
    const a2 = await inAzSubnet(vpc, '10.0.2.0/24', 'eu-west-1a')
    const b = await inAzSubnet(vpc, '10.0.3.0/24', 'eu-west-1b')
    const eips = [await allocate(), await allocate(), await allocate()]
    const natIn = async (subnet: string, eip: any) => call('CreateNatGateway', { SubnetId: subnet, AllocationId: eip.allocationId })

    setQuota4(scope, Q4.natGatewaysPerAvailabilityZone, 1)
    try {
      const first = (await natIn(a1, eips[0])).body.CreateNatGatewayResponse.natGateway.natGatewayId
      expect(error(await natIn(a2, eips[1]))).toMatchObject({ code: 'NatGatewayLimitExceeded' })
      expect((await natIn(b, eips[1])).status).toBe(200) // another Availability Zone has its own quota
      await call('DeleteNatGateway', { NatGatewayId: first })
      expect((await natIn(a2, eips[2])).status).toBe(200) // a deleted NAT gateway no longer counts
    } finally {
      resetQuota4(scope, Q4.natGatewaysPerAvailabilityZone)
    }

    const live = Object.keys(loadState4(scope).networkInterfaces).length
    setQuota4(scope, Q4.networkInterfacesPerRegion, live)
    try {
      expect(error(await call('CreateNatGateway', { SubnetId: a1, ConnectivityType: 'private' }))).toMatchObject({ code: 'NetworkInterfaceLimitExceeded' })
    } finally {
      resetQuota4(scope, Q4.networkInterfacesPerRegion)
    }

    for (const nat of items((await call('DescribeNatGateways', { 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpc })).body.DescribeNatGatewaysResponse.natGatewaySet)) {
      await call('DeleteNatGateway', { NatGatewayId: nat.natGatewayId })
    }
    for (const eip of eips) await call('ReleaseAddress', { AllocationId: eip.allocationId })
    for (const subnet of [a1, a2, b]) await call('DeleteSubnet', { SubnetId: subnet })
    await call('DeleteVpc', { VpcId: vpc })
  })

  it('runs out of addresses like a real subnet: 11 usable in a /28', async () => {
    const scope = { account: ACCOUNT, region: 'eu-west-1' }
    const vpc = await vpcOf('10.0.0.0/16')
    const small = await inAzSubnet(vpc, '10.0.9.0/28')
    expect(await subnetFree(small)).toBe(11) // 16 minus the 5 reserved addresses

    // take every address with interfaces of some other service
    const state = loadState4(scope)
    for (let host = 4; host <= 14; host++) {
      const id = `eni-0000000000000${host.toString(16).padStart(4, '0')}`
      state.networkInterfaces[id] = { NetworkInterfaceId: id, SubnetId: small, VpcId: vpc, PrivateIpAddress: `10.0.9.${host}`, PrivateIpAddresses: [{ Primary: true, PrivateIpAddress: `10.0.9.${host}` }], Tags: [] }
    }
    saveState4(scope, state)
    expect(await subnetFree(small)).toBe(0)
    expect(error(await call('CreateNatGateway', { SubnetId: small, ConnectivityType: 'private' }))).toMatchObject({ code: 'InsufficientFreeAddressesInSubnet' })

    const cleaned = loadState4(scope)
    for (const id of Object.keys(cleaned.networkInterfaces).filter(id => id.startsWith('eni-0000000000000'))) delete cleaned.networkInterfaces[id]
    saveState4(scope, cleaned)
    expect(await subnetFree(small)).toBe(11)
    await call('DeleteSubnet', { SubnetId: small })
    await call('DeleteVpc', { VpcId: vpc })
  })
})
