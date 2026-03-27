import { error, getRequestInfo, ok } from "../../common"
import { disableRegion } from "../../db/account"

export async function POST(request: Request) {
  // parse request info
  const { principalAccount } = getRequestInfo(request)
  // process parameters
  const body = await request.json()
  let { AccountId, RegionName } = body
  console.log(typeof AccountId)
  if (typeof AccountId === "undefined") {
    AccountId = principalAccount
  }
  // TODO check if calling role has account:GetAccountInformation
  try {
    disableRegion(AccountId, RegionName)
    return ok()
  } catch (e) {
    return error(e)
  }
}