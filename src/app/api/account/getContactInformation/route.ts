import { error, getRequestInfo, ok } from "../../common"
import { getContactInformation } from "../../db/account"

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
    const info = getContactInformation(AccountId)
    return ok({
        ContactInformation: info
    })
  } catch (e) {
    return error(e)
  }
}