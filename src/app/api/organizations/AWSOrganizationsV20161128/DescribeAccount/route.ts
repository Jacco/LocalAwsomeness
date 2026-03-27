import { createAccount, getAccount } from '../../../db'

export async function POST(request: Request) {
  const body = await request.json()
  const { AccountId } = body
  const requested = Date.now()
  try {
    const account = getAccount(AccountId)
    return new Response(JSON.stringify({
      "Account": { 
          // ^arn:aws:organizations::\d{12}:account\/o-[a-z0-9]{10,32}\/\d{12}
          // i think first account should be master account
          "Arn": `arn:aws::${account.id}:account/o-abcdefg/${account.id}`,
          "Email": account.email,
          "Id": account.id,
          "JoinedMethod": account.joinMethod.toString(),
          "JoinedTimestamp": account.joinedTimestamp,
          "Name": account.name,
          "State": "string", // PENDING_ACTIVATION | ACTIVE | SUSPENDED | PENDING_CLOSURE | CLOSED
          "Status": "string"  // ACTIVE | SUSPENDED | PENDING_CLOSURE
      }
      }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch(e) {
    return new Response(JSON.stringify({
      code: 'InvalidInputException',
      message: (e as Error).message
    }), { status: 400 }) 
  }
}