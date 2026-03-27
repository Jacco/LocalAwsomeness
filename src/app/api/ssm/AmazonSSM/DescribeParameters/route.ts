import { error, getRequestInfo, ok } from "../../../common"

export async function POST(request: Request) {
  // parse request info
  const { principalAccount, region } = getRequestInfo(request)
  // process parameters
  const body = await request.json()
  try {
    // TODO check if calling role has account:GetAccountInformation
    return ok({
        Parameters: [ 
            { 
                "AllowedPattern": "string",
                "ARN": "string",
                "DataType": "string",
                "Description": "string",
                "KeyId": "string",
                // "LastModifiedDate": number,
                "LastModifiedUser": "string",
                "Name": "string",
                "Policies": [ 
                    { 
                    "PolicyStatus": "string",
                    "PolicyText": "string",
                    "PolicyType": "string"
                    }
                ],
                "Tier": "string",
                "Type": "string",
                // "Version": number
            }
        ]
    })
  } catch (e) {
    return error(e)
  }
}

    // "Parameters": [
    //     {
    //         "Name": "/inspector-aws/service/inspector-linux-application-paths",
    //         "ARN": "arn:aws:ssm:eu-west-1:673385887142:parameter/inspector-aws/service/inspector-linux-application-paths",
    //         "Type": "StringList",
    //         "LastModifiedDate": 1744040289.399,
    //         "LastModifiedUser": "arn:aws:sts::673385887142:assumed-role/AWSServiceRoleForAmazonInspector2/inspector22106269870046400489",
    //         "Version": 1,
    //         "Tier": "Standard",
    //         "Policies": [],
    //         "DataType": "text"
    //     }