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
  // TODO check if calling role has account:GetPrimaryEmail
  try {
    const info = getAccount(AccountId)
    return ok({
      PrimaryEmail: info.email
    });
  } catch(e) {
    return error(e)
  }
}
