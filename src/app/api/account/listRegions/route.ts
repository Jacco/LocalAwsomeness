import { error, getRequestInfo, ok } from "../../common"
import { listRegions } from "../../db/account"

export async function POST(request: Request) {
  const { principalAccount } = getRequestInfo(request)
  const body = await request.json()
  let { AccountId } = body
  if (!AccountId) {
    AccountId = principalAccount
  }
  // TODO check if calling role has account:GetAccountInformation
  try {
    const regions = Object.entries(listRegions(AccountId)).map(value => ({ RegionName: value[0], RegionOptStatus: value[1] }))
    return ok({
      "Regions": regions
    })
  } catch(e) {
    return error(e)
  }
}