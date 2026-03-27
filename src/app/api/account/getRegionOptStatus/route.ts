import { error, getRequestInfo, ok } from "../../common"
import { getRegion } from "../../db/account"

export async function POST(request: Request) {
  const { principalAccount } = getRequestInfo(request)
  const body = await request.json()
  let { AccountId, RegionName } = body
  if (!AccountId) {
    AccountId = principalAccount
  }
  try {
    const status = getRegion(AccountId, RegionName)
    // TODO check if calling role has account:GetAccountInformation
    return ok({
        "RegionName": RegionName,
        "RegionOptStatus": status
    })
  } catch (e) {
    return error(e)
  }
}