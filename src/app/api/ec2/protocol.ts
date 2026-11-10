import { randomUUID } from "crypto"
import { AwsError } from "../common"
import type { ProtocolAdapter } from "../registry"
import { decodeInput, encodeError, encodeOutput } from "./model"

export const DRY_RUN_OPERATION = () =>
  new AwsError('DryRunOperation', 'Request would have succeeded, but DryRun flag is set.', 412)

function xml(body: string, status: number, requestId: string): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/xml;charset=UTF-8',
      'x-amzn-RequestId': requestId,
      Server: 'AmazonEC2',
    },
  })
}

// Form body with Action= and Version=, XML responses; names and shapes come from the EC2 service model.
export class Ec2Protocol implements ProtocolAdapter<any> {
  async decode(request: Request) {
    const form = new URLSearchParams(await request.text())
    const action = form.get('Action')
    if (!action) {
      throw new AwsError('MissingAction', 'Request is missing Action or Operation parameter.')
    }
    return { action, params: decodeInput(action, form) }
  }

  unknownOperation(action: string) {
    return new AwsError('InvalidAction', `The action ${action} is not valid for this web service.`)
  }

  success(action: string, result: unknown) {
    const requestId = randomUUID()
    return xml(encodeOutput(action, result, requestId), 200, requestId)
  }

  failure(error: unknown) {
    const requestId = randomUUID()
    if (!(error instanceof AwsError)) {
      console.error(error)
    }
    const err = error instanceof AwsError ? error : new AwsError('InternalError', 'An internal error has occurred', 500)
    return xml(encodeError(err.type, err.message, requestId), err.status, requestId)
  }
}
