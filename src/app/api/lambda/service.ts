import { defineService, type RequestContext } from "../registry"
import { functionArn, parseReference } from "../db/lambda"
import { createFunction, deleteFunction, getFunction, getFunctionCodeSigningConfig, getFunctionConcurrency, getFunctionConfiguration, getFunctionRecursionConfig, listFunctions, listTags, listVersionsByFunction } from "./functions"
import { invoke } from "./invoke"
import { LambdaProtocol } from "./protocol"

// The ARN of the function a request names, for the policy engine; '*' when it cannot be read (the handler then answers).
const functionResource = ({ account, region, params }: RequestContext) => {
  try {
    const name = params.FunctionName
    return [functionArn({ account, region }, typeof name === 'string' ? parseReference(name).name : '*')]
  } catch {
    return ['*']
  }
}

export const lambda = defineService({
  iamPrefix: 'lambda',
  protocol: new LambdaProtocol(),
  operations: {
    CreateFunction: { handler: createFunction, action: 'lambda:CreateFunction', resources: functionResource },
    GetFunction: { handler: getFunction, resources: functionResource },
    GetFunctionConfiguration: { handler: getFunctionConfiguration, resources: functionResource },
    ListFunctions: listFunctions,
    ListVersionsByFunction: { handler: listVersionsByFunction, resources: functionResource },
    GetFunctionCodeSigningConfig: { handler: getFunctionCodeSigningConfig, resources: functionResource },
    GetFunctionRecursionConfig: { handler: getFunctionRecursionConfig, resources: functionResource },
    GetFunctionConcurrency: { handler: getFunctionConcurrency, action: 'lambda:GetFunctionConcurrency', resources: functionResource },
    ListTags: { handler: listTags, resources: ({ params }) => [String(params.Resource)] },
    DeleteFunction: { handler: deleteFunction, resources: functionResource },
    Invoke: { handler: invoke, action: 'lambda:InvokeFunction', resources: functionResource },
  },
})
