import { error, getRequestInfo, ok } from "../../common"
import { putAccountName } from "../../db/account"

export async function POST(request: Request) {
  // parse request info
  const { principalAccount } = getRequestInfo(request)
  // process parameters
  const body = await request.json()
  let { AccountId, AccountName } = body
  if (!AccountId) {
    AccountId = principalAccount
  }
  // TODO check if calling role has account:PutAccountName
  try {
    putAccountName(AccountId, AccountName)
    return ok();
  } catch(e) {
    return error(e)
  }
}
