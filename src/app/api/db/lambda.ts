import { AwsError } from "../common"
import * as store from "./store"

// State of the Lambda service for one account and Region (db/<account>/<region>/lambda.json). Records are stored in the
// shape of the API: `Configuration` is a FunctionConfiguration as GetFunction returns it.

export interface FunctionRecord {
  Configuration: Record<string, any>
  // The code is not here: it is the files in db/<account>/<region>/lambda-code/<function>/ (src/app/api/lambda/code.ts).
  Tags: Record<string, string>
}

// What an invocation did, kept for looking at afterwards (the newest first, the last few per function). This is not state
// of the Lambda service and AWS has no API for it, so it is not in lambda.json: it is what the simulator observed, in
// db/<account>/<region>/lambda-invocations.json, read with GET /api/lambda/inspect. The log output belongs in CloudWatch
// Logs once that exists; the connections and their traces are what this app is for. Text is kept as lines.
export interface InvocationRecord {
  RequestId: string
  Time: string
  InvocationType: string
  StatusCode: number
  FunctionError?: string
  DurationMs: number
  // What the code saw, in virtual seconds, against the real time it took.
  VirtualSeconds: number
  // The log of the invocation, as AWS shows it (START, the output of the function, END, REPORT).
  Log: string[]
  // Every connection the code made with the trace of the decision (src/app/api/runtime/run.ts), line by line.
  Network: string[]
  Connections: { host: string; port: number; verdict: string; attempts: number; cause?: string }[]
}

export interface LambdaState {
  functions: Record<string, FunctionRecord>
}

// Function name -> its invocations, newest first.
export type Invocations = Record<string, InvocationRecord[]>

interface Scope {
  account: string
  region: string
}

const invocationsKey = ({ account, region }: Scope): store.StoreKey => ({ service: 'lambda-invocations', account, region })
export const loadInvocations = (scope: Scope): Invocations => store.read<Invocations>(invocationsKey(scope), {})
export const saveInvocations = (scope: Scope, invocations: Invocations) => store.write(invocationsKey(scope), invocations)

const key = ({ account, region }: Scope): store.StoreKey => ({ service: 'lambda', account, region })

// Only `functions` is state of the service; invocation records used to be kept here too and are dropped on the next save.
export const loadLambda = (scope: Scope): LambdaState => ({ functions: store.read<LambdaState>(key(scope), { functions: {} }).functions })
export const saveLambda = (scope: Scope, state: LambdaState) => store.write(key(scope), state)

export const functionArn = ({ account, region }: Scope, name: string) => `arn:aws:lambda:${region}:${account}:function:${name}`

// A function is addressed by name, partial ARN (account:function:name) or full ARN, optionally with a qualifier.
const REFERENCE = /^(?:arn:aws[a-zA-Z-]*:lambda:([a-z]{2}(?:-gov)?-[a-z]+-\d):(\d{12}):function:|(?:(\d{12}):)?(?:function:)?)([a-zA-Z0-9-_]+)(?::(\$LATEST|[a-zA-Z0-9-_]+))?$/

export function parseReference(reference: string): { name: string; region?: string; account?: string; qualifier?: string } {
  const m = REFERENCE.exec(reference)
  if (!m) {
    throw new AwsError('ValidationException', `1 validation error detected: Value '${reference}' at 'functionName' failed to satisfy constraint: Member must satisfy regular expression pattern: (arn:(aws[a-zA-Z-]*)?:lambda:)?([a-z]{2}(-gov)?-[a-z]+-\\d{1}:)?(\\d{12}:)?(function:)?([a-zA-Z0-9-_]+)(:(\\$LATEST|[a-zA-Z0-9-_]+))?`, 400)
  }
  return { region: m[1], account: m[2] ?? m[3], name: m[4], qualifier: m[5] }
}

export function notFound(scope: Scope, name: string): AwsError {
  return new AwsError('ResourceNotFoundException', `Function not found: ${functionArn(scope, name)}`, 404)
}
