import { error, getRequestInfo, ok } from "../../common"
import { enableRegion } from "../../db/account"

export async function POST(request: Request) {
  // parse request info
  const { principalAccount } = getRequestInfo(request)
  // process parameters
  const body = await request.json()
  let { AccountId, RegionName } = body
  if (!AccountId) {
    AccountId = principalAccount
  }
  try {
    enableRegion(AccountId, RegionName)
    // TODO check if calling role has account:GetAccountInformation
    return ok()
  } catch (e) {
    return error(e)
  }
}