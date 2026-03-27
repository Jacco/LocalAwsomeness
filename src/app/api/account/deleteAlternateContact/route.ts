import { error, getRequestInfo, ok } from "../../common"
import { deleteAlternateContact } from "../../db/account"

export async function POST(request: Request) {
  // parse request info
  const { principalAccount } = getRequestInfo(request)
  // process parameters
  const body = await request.json()
  let { AccountId, AlternateContactType } = body
  if (!AccountId) {
    AccountId = principalAccount
  }
  // TODO check if calling role has account:GetAccountInformation
  try {
    deleteAlternateContact(AccountId, AlternateContactType)
    return ok()
  } catch (e) {
    return error(e)
  }
}