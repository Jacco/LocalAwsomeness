import { randomUUID } from "crypto"
import { readFileSync } from "fs"
import { join } from "path"
import { AwsError } from "../common"
import { loadState } from "../db/ec2/state"
import { loadLambda, saveLambda, type FunctionRecord, type InvocationRecord } from "../db/lambda"
import { QUOTAS, hardLimit } from "../quotas"
import type { RequestContext } from "../registry"
import { BadRunRequest, runInContext, type RunResult } from "../runtime/run"
import { codeDirectory } from "./code"
import { invalidParameter } from "./errors"
import { lookup } from "./functions"
import { sharedInterface, vpcSettings } from "./network"

// Invoke: the function runs in a Python subprocess behind the network shim (src/app/api/runtime/), in the network position
// of its shared interface (or the AWS-managed network without a VPC), with the credentials of its execution role. The
// answer is the payload, the log tail and the error flag like AWS's; the connections it made and their traces are kept
// with the invocation (db/<account>/<region>/lambda.json, GET /api/lambda/inspect).

const KEPT_INVOCATIONS = 10
const LOG_TAIL_BYTES = 4096
// Where the emulated services answer, for the code that runs in the subprocess.
const simulatorUrl = () => process.env.JPK_SIMULATOR_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
const bootstrap = () => readFileSync(join(process.cwd(), 'src/app/api/lambda/bootstrap.py'), 'utf8')

interface Outcome {
  statusCode: number
  functionError?: string
  payload: string
  log: string
  durationMs: number
}

const iso = () => new Date().toISOString()

function parsePayload(text: string): string {
  const payload = text.trim() === '' ? '{}' : text
  if (Buffer.byteLength(payload) > hardLimit(QUOTAS.lambdaPayloadSynchronous)) {
    throw new AwsError('RequestTooLargeException', `Request must be smaller than ${hardLimit(QUOTAS.lambdaPayloadSynchronous)} bytes for the Invoke operation`, 413)
  }
  try {
    JSON.parse(payload)
  } catch (error) {
    throw new AwsError('InvalidRequestContentException', `Could not parse request body into json: Could not parse payload into json: ${(error as Error).message}`, 400)
  }
  return payload
}

async function execute(ctx: RequestContext, name: string, record: FunctionRecord, payload: string, requestId: string): Promise<{ outcome: Outcome; run: RunResult }> {
  const c = record.Configuration
  const scope = { account: ctx.account, region: ctx.region }
  const vpc = vpcSettings(c)
  let from: { networkInterfaceId: string } | undefined
  if (vpc) {
    const eni = sharedInterface(loadState(scope), vpc.subnetIds[0], vpc.securityGroupIds)
    if (!eni) {
      throw new AwsError('ServiceException', `The network interface of function ${name} does not exist`, 500)
    }
    from = { networkInterfaceId: eni.NetworkInterfaceId }
  }
  const timeoutSeconds: number = c.Timeout
  let run: RunResult
  try {
    run = await runInContext({
      ...scope,
      from,
      role: c.Role.split('/').at(-1),
      sessionName: name,
      code: bootstrap(),
      files: { 'event.json': payload },
      env: {
        ...c.Environment?.Variables,
        JPK_CODE_DIR: codeDirectory(scope, name),
        AWS_LAMBDA_FUNCTION_NAME: name,
        AWS_LAMBDA_FUNCTION_VERSION: '$LATEST',
        AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(c.MemorySize),
        AWS_LAMBDA_LOG_GROUP_NAME: `/aws/lambda/${name}`,
        AWS_LAMBDA_LOG_STREAM_NAME: `${new Date().toISOString().slice(0, 10).replace(/-/g, '/')}/[$LATEST]${randomUUID().replace(/-/g, '')}`,
        AWS_LAMBDA_INITIALIZATION_TYPE: 'on-demand',
        AWS_EXECUTION_ENV: `AWS_Lambda_${c.Runtime}`,
        _HANDLER: c.Handler,
        TZ: ':UTC',
        LANG: 'en_US.UTF-8',
        JPK_REQUEST_ID: requestId,
        JPK_TIMEOUT_MS: String(timeoutSeconds * 1000),
        JPK_FUNCTION_ARN: c.FunctionArn,
      },
      resultFile: 'outcome.json',
      virtualDeadlineSeconds: timeoutSeconds,
      timeoutSeconds: timeoutSeconds + 10,
      simulatorUrl: simulatorUrl(),
    })
  } catch (error) {
    if (error instanceof BadRunRequest) {
      throw new AwsError('ServiceException', `Lambda could not start function ${name}: ${error.message}`, 500)
    }
    throw error
  }

  const header = `START RequestId: ${requestId} Version: $LATEST\n`
  let functionError: string | undefined
  let payloadOut = ''
  let durationMs: number
  let extra = ''
  const outcome = run.output ? JSON.parse(run.output) : undefined
  if (run.virtualTimedOut || run.timedOut) {
    const message = `${iso()} ${requestId} Task timed out after ${timeoutSeconds.toFixed(2)} seconds`
    functionError = 'Unhandled'
    payloadOut = JSON.stringify({ errorMessage: message })
    extra = `\n${message}\n\n`
    durationMs = timeoutSeconds * 1000
  } else if (outcome?.error) {
    functionError = 'Unhandled'
    payloadOut = JSON.stringify(outcome.error)
    durationMs = outcome.durationSeconds * 1000
  } else if (outcome) {
    payloadOut = outcome.payload
    durationMs = outcome.durationSeconds * 1000
    if (Buffer.byteLength(payloadOut) > hardLimit(QUOTAS.lambdaPayloadSynchronous)) {
      functionError = 'Function.ResponseSizeTooLarge'
      payloadOut = JSON.stringify({ errorMessage: `Response payload size exceeded maximum allowed payload size (${hardLimit(QUOTAS.lambdaPayloadSynchronous)} bytes).`, errorType: 'Function.ResponseSizeTooLarge' })
    }
  } else {
    functionError = 'Unhandled'
    payloadOut = JSON.stringify({ errorMessage: `RequestId: ${requestId} Error: Runtime exited with error: exit status ${run.exitCode}`, errorType: 'Runtime.ExitError' })
    durationMs = (run.virtualSeconds + run.realSeconds) * 1000
  }
  const billed = Math.ceil(durationMs)
  const log = `${header}${run.log}${extra}END RequestId: ${requestId}\nREPORT RequestId: ${requestId}\tDuration: ${durationMs.toFixed(2)} ms\tBilled Duration: ${billed} ms\tMemory Size: ${c.MemorySize} MB\t\n`
  return { outcome: { statusCode: 200, functionError, payload: payloadOut, log, durationMs }, run }
}

function remember(ctx: RequestContext, name: string, requestId: string, type: string, outcome: Outcome, run: RunResult) {
  const scope = { account: ctx.account, region: ctx.region }
  const lambda = loadLambda(scope)
  if (!lambda.functions[name]) {
    return
  }
  const record: InvocationRecord = {
    RequestId: requestId,
    Time: iso(),
    InvocationType: type,
    StatusCode: outcome.statusCode,
    FunctionError: outcome.functionError,
    DurationMs: outcome.durationMs,
    VirtualSeconds: run.virtualSeconds,
    Log: outcome.log,
    Network: run.text,
    Connections: run.connections.map(c => ({ host: c.host, port: c.port, verdict: c.verdict, attempts: c.attempts, cause: c.trace.cause })),
  }
  lambda.invocations ??= {}
  lambda.invocations[name] = [record, ...(lambda.invocations[name] ?? [])].slice(0, KEPT_INVOCATIONS)
  saveLambda(scope, lambda)
}

export async function invoke(ctx: RequestContext): Promise<Response> {
  const { params: p } = ctx
  const { name, record } = lookup(ctx, p.FunctionName, p.Qualifier)
  const type: string = p.InvocationType ?? 'RequestResponse'
  if (!['RequestResponse', 'Event', 'DryRun'].includes(type)) {
    throw new AwsError('ValidationException', `1 validation error detected: Value '${type}' at 'invocationType' failed to satisfy constraint: Member must satisfy enum value set: [Event, RequestResponse, DryRun]`, 400)
  }
  const logType: string = p.LogType ?? 'None'
  if (!['None', 'Tail'].includes(logType)) {
    throw new AwsError('ValidationException', `1 validation error detected: Value '${logType}' at 'logType' failed to satisfy constraint: Member must satisfy enum value set: [Tail, None]`, 400)
  }
  if (p.ClientContext !== undefined) {
    throw invalidParameter(`Parameter 'ClientContext' is not supported by this simulator yet`)
  }
  const payload = parsePayload(p.Payload ?? '')
  if (record.Configuration.State === 'Failed') {
    throw new AwsError('ResourceConflictException', `The operation cannot be performed at this time. The function is currently in the following state: Failed (${record.Configuration.StateReasonCode})`, 409)
  }
  const headers: Record<string, string> = { 'X-Amz-Executed-Version': '$LATEST' }
  if (type === 'DryRun') {
    return new Response(null, { status: 204, headers })
  }
  const requestId = randomUUID()
  headers['x-amzn-RequestId'] = requestId
  const run = async () => {
    const { outcome, run } = await execute(ctx, name, record, payload, requestId)
    remember(ctx, name, requestId, type, outcome, run)
    return outcome
  }
  if (type === 'Event') {
    // the caller is told at once; what the function does is only visible through its invocation record (AWS retries a
    // failed asynchronous invocation twice, which is not modelled)
    void run().catch(error => console.error(error))
    return new Response(null, { status: 202, headers })
  }
  const outcome = await run()
  if (outcome.functionError) {
    headers['X-Amz-Function-Error'] = outcome.functionError
  }
  if (logType === 'Tail') {
    headers['X-Amz-Log-Result'] = Buffer.from(outcome.log).subarray(-LOG_TAIL_BYTES).toString('base64')
  }
  return new Response(outcome.payload, { status: outcome.statusCode, headers: { ...headers, 'Content-Type': 'application/json' } })
}
