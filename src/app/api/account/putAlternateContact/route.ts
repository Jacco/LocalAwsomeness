import { error, getRequestInfo, ok } from "../../common"
import { putAlternateContact } from "../../db/account"

export async function POST(request: Request) {
  // parse request info
  const { principalAccount } = getRequestInfo(request)
  // process parameters
  const body = await request.json()
  let { AccountId, AlternateContactType, EmailAddress, Name, PhoneNumber, Title } = body
  if (!AccountId) {
    AccountId = principalAccount
  }
  // TODO check if calling role has account:GetAccountInformation
  try {
    putAlternateContact(AccountId, AlternateContactType, {
        EmailAddress, Name, PhoneNumber, Title
    })
    return ok()
  } catch (e) {
    return error(e)
  }
}