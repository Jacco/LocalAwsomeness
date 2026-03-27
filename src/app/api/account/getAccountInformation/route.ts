import { error, getRequestInfo, ok } from "../../common"
import { getAccount } from "../../db/organizations"

export async function POST(request: Request) {
  // parse request info
  const { principalAccount } = getRequestInfo(request)
  // process parameters
  const body = await request.json()
  let { AccountId } = body
  if (!AccountId) {
    AccountId = principalAccount
  }
  // TODO check if calling role has account:GetAccountInformation
  try {
    const info = getAccount(AccountId)
    return ok({
        AccountCreatedDate: info.requestedTimestamp,
        AccountId: info.id,
        AccountName: info.name
    });
  } catch(e) {
    return error(e)
  }
}