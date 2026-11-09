import { awsJson, awsJsonError, AwsError, getRequestInfo } from "../../../common"
import { handlers } from "../../handlers"

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    const { action } = await params
    const handler = Object.hasOwn(handlers, action) ? handlers[action] : undefined
    if (!handler) {
      throw new AwsError('UnknownOperationException', `Unknown operation ${action}`)
    }
    const { principalAccount } = getRequestInfo(request)
    const text = await request.text()
    let body: any = {}
    if (text.trim()) {
      try {
        body = JSON.parse(text)
      } catch {
        throw new AwsError('InvalidInputException', 'The request body is not valid JSON.')
      }
    }
    return awsJson(handler({ account: principalAccount, body }))
  } catch (e) {
    return awsJsonError(e)
  }
}
