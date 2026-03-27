import { error, getRequestInfo, ok } from "../../../common"
import { getParameter } from '../../../db/ssm'

export async function POST(request: Request) {
  // parse request info
  const { principalAccount, region } = getRequestInfo(request)
  // process parameters
  const body = await request.json()
  let { Name, WithDecryption } = body
  // TODO check if calling role has account:GetAccountInformation
  try {
    const parameter = getParameter(principalAccount, region, Name)
    return ok({
        "Parameter": parameter
    })
  } catch (e) {
    return error(e)
  }
}

// {
//    "Parameter": { 
//       "ARN": "string",
//       "DataType": "string",
//       "LastModifiedDate": number,
//       "Name": "string",
//       "Selector": "string",
//       "SourceResult": "string",
//       "Type": "string",
//       "Value": "string",
//       "Version": number
//    }
// }