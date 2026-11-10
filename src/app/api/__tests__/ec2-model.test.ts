import { decodeInput, encodeError, encodeOutput } from '@/app/api/ec2/model'

const form = (body: string) => new URLSearchParams(body)

describe('ec2 model codec', () => {
  describe('decodeInput (bodies produced by botocore EC2Serializer)', () => {
    it('decodes scalars, enums, booleans and nested tag specifications', () => {
      const input = decodeInput('CreateVpc', form(
        'Action=CreateVpc&Version=2016-11-15&CidrBlock=10.0.0.0%2F16&InstanceTenancy=default&DryRun=true' +
        '&TagSpecification.1.ResourceType=vpc&TagSpecification.1.Tag.1.Key=Name&TagSpecification.1.Tag.1.Value=a+b%26c' +
        '&TagSpecification.1.Tag.2.Key=x&TagSpecification.1.Tag.2.Value=y'))

      expect(input).toEqual({
        CidrBlock: '10.0.0.0/16',
        InstanceTenancy: 'default',
        DryRun: true,
        TagSpecifications: [{
          ResourceType: 'vpc',
          Tags: [{ Key: 'Name', Value: 'a b&c' }, { Key: 'x', Value: 'y' }]
        }]
      })
    })

    it('decodes id lists, filters with value lists and integers', () => {
      const input = decodeInput('DescribeVpcs', form(
        'Action=DescribeVpcs&VpcId.1=vpc-1&VpcId.2=vpc-2&Filter.1.Name=tag%3AName&Filter.1.Value.1=a&Filter.1.Value.2=b' +
        '&Filter.2.Name=is-default&Filter.2.Value.1=true&MaxResults=5'))

      expect(input).toEqual({
        VpcIds: ['vpc-1', 'vpc-2'],
        Filters: [{ Name: 'tag:Name', Values: ['a', 'b'] }, { Name: 'is-default', Values: ['true'] }],
        MaxResults: 5
      })
    })

    it('decodes attribute-value structures', () => {
      expect(decodeInput('ModifyVpcAttribute', form('Action=ModifyVpcAttribute&VpcId=vpc-1&EnableDnsHostnames.Value=true')))
        .toEqual({ VpcId: 'vpc-1', EnableDnsHostnames: { Value: true } })
      expect(decodeInput('ModifySubnetAttribute', form('Action=ModifySubnetAttribute&SubnetId=subnet-1&MapPublicIpOnLaunch.Value=false')))
        .toEqual({ SubnetId: 'subnet-1', MapPublicIpOnLaunch: { Value: false } })
    })

    it('uses the query name of renamed members', () => {
      expect(decodeInput('DescribeAccountAttributes', form('Action=DescribeAccountAttributes&AttributeName.1=default-vpc&AttributeName.2=supported-platforms')))
        .toEqual({ AttributeNames: ['default-vpc', 'supported-platforms'] })
      expect(decodeInput('DeleteTags', form('Action=DeleteTags&ResourceId.1=vpc-1&Tag.1.Key=k')))
        .toEqual({ Resources: ['vpc-1'], Tags: [{ Key: 'k' }] })
    })

    it('rejects a missing required parameter and an invalid enum value', () => {
      expect(() => decodeInput('CreateSubnet', form('Action=CreateSubnet&CidrBlock=10.0.0.0%2F24')))
        .toThrow('The request must contain the parameter VpcId')
      expect(() => decodeInput('CreateVpc', form('Action=CreateVpc&CidrBlock=10.0.0.0%2F16&InstanceTenancy=bogus')))
        .toThrow('Value (bogus) for parameter instanceTenancy is invalid.')
    })
  })

  describe('encodeOutput', () => {
    it('writes locationName elements, item lists and a lowercase requestId without a Result wrapper', () => {
      const xml = encodeOutput('DescribeVpcs', {
        Vpcs: [{
          VpcId: 'vpc-1', State: 'available', CidrBlock: '10.0.0.0/16', IsDefault: false,
          Tags: [{ Key: 'Name', Value: 'a & <b>' }],
          CidrBlockAssociationSet: [{ AssociationId: 'a-1', CidrBlock: '10.0.0.0/16', CidrBlockState: { State: 'associated' } }]
        }]
      }, 'req-1')

      expect(xml).toContain('<DescribeVpcsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">')
      expect(xml).toContain('<requestId>req-1</requestId>')
      expect(xml).toContain('<vpcSet><item>')
      expect(xml).toContain('<vpcId>vpc-1</vpcId>')
      expect(xml).toContain('<isDefault>false</isDefault>')
      expect(xml).toContain('<tagSet><item><key>Name</key><value>a &amp; &lt;b&gt;</value></item></tagSet>')
      expect(xml).toContain('<cidrBlockState><state>associated</state></cidrBlockState>')
      expect(xml).not.toContain('Result')
    })

    it('writes empty lists as empty elements and skips undefined members', () => {
      const xml = encodeOutput('DescribeVpcs', { Vpcs: [{ VpcId: 'vpc-1', Tags: [] }] }, 'r')
      expect(xml).toContain('<tagSet/>')
      expect(xml).not.toContain('<state>')
    })

    it('writes timestamps as ISO 8601 and <return>true</return> for operations without output', () => {
      expect(encodeOutput('DeleteVpc', undefined, 'r')).toContain('<return>true</return>')
      expect(encodeOutput('DescribeNetworkAcls', {
        NetworkAcls: [{ NetworkAclId: 'acl-1', Entries: [], Associations: [] }]
      }, 'r')).toContain('<networkAclId>acl-1</networkAclId>')
    })
  })

  it('encodeError uses the EC2 Response/Errors envelope', () => {
    expect(encodeError('InvalidVpcID.NotFound', "The vpc ID 'vpc-1' does not exist", 'req-2')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Errors><Error><Code>InvalidVpcID.NotFound</Code>' +
      "<Message>The vpc ID 'vpc-1' does not exist</Message></Error></Errors><RequestID>req-2</RequestID></Response>")
  })
})
