export async function POST(request: Request) {
    const body = await request.text()
    const prms = new URLSearchParams(body)
    // TODO Version Prefix MaxItem and also Marker
    if (prms.get('Action') == 'DescribeSecurityGroups') {
        return new Response(
            `
<DescribeSecurityGroupsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
    <requestId>edb7c570-be05-4192-bd1b-example</requestId>
    <securityGroupInfo>
        <item>
            <ownerId>123456789012</ownerId>
            <groupId>sg-1a2b3c4d</groupId>
            <groupName>MySecurityGroup</groupName>
            <groupDescription>MySecurityGroup</groupDescription>
            <vpcId>vpc-81326ae4</vpcId>
            <ipPermissions>
                <item>
                    <ipProtocol>tcp</ipProtocol>
                    <fromPort>22</fromPort>
                    <toPort>22</toPort>
                    <groups/>
                    <ipRanges>
                        <item>
                            <cidrIp>0.0.0.0/0</cidrIp>
                        </item>
                    </ipRanges>
                    <prefixListIds/>
                </item>
                <item>
                    <ipProtocol>icmp</ipProtocol>
                    <fromPort>-1</fromPort>
                    <toPort>-1</toPort>
                    <groups>
                        <item>
                            <securityGroupRuleId>sgr-abcdefghi01234560</securityGroupRuleId>
                            <userId>111222333444</userId>
                            <groupId>sg-11aa22bb</groupId>
                            <vpcId>vpc-dd326ab8</vpcId>
                            <vpcPeeringConnectionId>pcx-11223344</vpcPeeringConnectionId>
                            <peeringStatus>active</peeringStatus>
                        </item>
                    </groups>
                    <ipRanges/>
                    <prefixListIds/>
                </item>
            </ipPermissions>
            <ipPermissionsEgress>
                <item>
                    <ipProtocol>-1</ipProtocol>
                    <groups/>
                    <ipRanges>
                        <item>
                            <cidrIp>0.0.0.0/0</cidrIp>
                        </item>
                    </ipRanges>
                    <prefixListIds/>
                </item>
            </ipPermissionsEgress>
        </item>
    </securityGroupInfo>
</DescribeSecurityGroupsResponse>
`,
            {
                status: 201,
                headers: { 'Content-Type': 'application/xml' }
            }
        )
    }
    console.log('iam', prms)
    return new Response(JSON.stringify({
    }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' }
  });  
}
