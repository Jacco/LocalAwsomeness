import { createAccount, getAccount, getCreateAccountStatus } from '../../../db'

export async function POST(request: Request) {
  const body = await request.json()
  const { CreateAccountRequestId } = body
  const requested = Date.now()
  try {
    const account = getCreateAccountStatus(CreateAccountRequestId)
    return new Response(JSON.stringify({
        CreateAccountStatus: { 
            "AccountId": account.id,
            "AccountName": account.name,
            "CompletedTimestamp": account.completedTimestamp,
            // "FailureReason": "string",
            // "GovCloudAccountId": "string",
            "Id": CreateAccountRequestId,
            "RequestedTimestamp": account.requestedTimestamp,
            "State": "SUCCEEDED" // IN_PROGRESS | SUCCEEDED | FAILED
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