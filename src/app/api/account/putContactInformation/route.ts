import { error, getRequestInfo, ok } from "../../common"
import { putContactInformation } from "../../db/account"

export async function POST(request: Request) {
  // parse request info
  const { principalAccount } = getRequestInfo(request)
  // process parameters
  const body = await request.json()
  let { AccountId, ContactInformation } = body
  if (!AccountId) {
    AccountId = principalAccount
  }
  // TODO check if calling role has account:GetAccountInformation
  try {
    putContactInformation(AccountId, ContactInformation)
    return ok()
  } catch (e) {
    return error(e)
  }
}