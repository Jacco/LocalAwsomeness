import { putParameter } from '../../../db/ssm'
import { error, getRequestInfo, ok } from "../../../common"

// parameter*
//     aws:RequestTag/${TagKey}
//     aws:TagKeys
//     ssm:Overwrite
//     ssm:Policies

// aws:PrincipalArn
// aws:PrincipalAccount
// aws:PrincipalOrgPaths
// aws:PrincipalOrgID
// aws:PrincipalTag/tag-key
// aws:PrincipalIsAWSService
// aws:PrincipalServiceName
// aws:PrincipalServiceNamesList
// aws:PrincipalType
// aws:userid
// aws:username
// aws:AssumedRoot
// aws:FederatedProvider
// aws:TokenIssueTime
// aws:MultiFactorAuthAge
// aws:MultiFactorAuthPresent
// aws:ChatbotSourceArn

// aws:Ec2InstanceSourceVpc
// aws:Ec2InstanceSourcePrivateIPv4

// aws:SourceIdentity

// ec2:RoleDelivery
// ec2:SourceInstanceArn

// glue:RoleAssumedBy
// glue:CredentialIssuingService

// lambda:SourceFunctionArn

// ssm:SourceInstanceArn

// identitystore:UserId

// aws:SourceIp
// aws:SourceVpc
// aws:SourceVpcArn
// aws:SourceVpce
// aws:VpceAccount
// aws:VpceOrgID
// aws:VpceOrgPaths
// aws:VpcSourceIp
// aws:ResourceAccount
// aws:ResourceOrgID
// aws:ResourceOrgPaths

// aws:ResourceTag/tag-key

// aws:CalledVia
// aws:CalledViaFirst
// aws:CalledViaLast
// aws:ViaAWSService

// aws:CurrentTime
// aws:EpochTime

// aws:referer

// aws:RequestedRegion
// aws:RequestTag/tag-key
// aws:TagKeys

// aws:SecureTransport
// aws:SourceAccount

// aws:SourceArn
// aws:SourceOrgID
// aws:SourceOrgPaths

// aws:UserAgent

// aws:IsMcpServiceAction

// {
//    "AllowedPattern": "string",
//    "DataType": "string",
//    "Description": "string",
//    "KeyId": "string",
//    "Name": "string",
//    "Overwrite": boolean,
//    "Policies": "string",
//    "Tags": [ 
//       { 
//          "Key": "string",
//          "Value": "string"
//       }
//    ],
//    "Tier": "string",
//    "Type": "string",
//    "Value": "string"
// }

export async function POST(request: Request) {
  // parse request info
  const { principalAccount, region } = getRequestInfo(request)
  // process parameters
  const body = await request.json()
  let { Name, Value, Tier, Type, KeyId, Description, DataType, AllowedPattern, Tags } = body
  // TODO check if calling role has account:GetAccountInformation
  try {
    putParameter(principalAccount, region, { 
        name: Name, 
        value: Value, 
        dataType: DataType,
        tier: Tier
    })
    return ok()
  } catch (e) {
    return error(e)
  }
}