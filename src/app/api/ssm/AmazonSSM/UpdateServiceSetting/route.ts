import { setServiceSetting } from '../../../db/ssm'
import { error, getRequestInfo, ok } from "../../../common"

export async function POST(request: Request) {
  // parse request info
  const { principalAccount, region, user } = getRequestInfo(request)
  // process parameters
  const body = await request.json()
  let { SettingId, SettingValue } = body
  // TODO check if calling role has account:GetAccountInformation
  try {
    setServiceSetting(principalAccount, region, SettingId, SettingValue, user)
    return ok()
  } catch (e) {
    return error(e)
  }
}