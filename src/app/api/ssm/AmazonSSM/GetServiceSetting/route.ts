import { getServiceSetting } from '../../../db/ssm'
import { error, getRequestInfo, ok } from "../../../common"

export async function POST(request: Request) {
  // parse request info
  const { principalAccount, region } = getRequestInfo(request)
  // process parameters
  const body = await request.json()
  let { SettingId } = body
  try {
    // TODO check if calling role has account:GetAccountInformation
    const setting = getServiceSetting(principalAccount, region, SettingId)
    return ok({
        "ServiceSetting": setting
    })
  } catch (e) {
    return error(e)
  }
}
