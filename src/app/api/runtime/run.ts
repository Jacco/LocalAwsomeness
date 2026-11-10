import { spawn, type StdioOptions } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Duplex } from 'stream'
import { issueSession } from '../db/credentials'
import { loadState } from '../db/ec2/state'
import * as iam from '../db/iam'
import { accountDirExists } from '../db/store'
import { BadReachRequest, resolveSource, type ReachRequest } from '../network/live'
import { reachPublicService, type Source } from '../network/reach'
import { renderTrace, type Trace } from '../network/trace'

// Runs a Python script as if it were somewhere in the simulated network (docs/walking-skeleton.md, step 3b). The script
// runs in a subprocess behind the shim (netshim.py); every connection it opens is decided here by the network model, from
// the live EC2 state at that moment, and recorded with its trace. The subprocess is asynchronous on purpose: the script
// calls back into this same server, which must stay free to answer.

export interface RunRequest {
  account: string
  region: string
  // Where the code runs: the same naming as for a trace (ReachRequest.from).
  from: ReachRequest['from']
  // The execution role: the code gets the credentials of a session of this role, as a Lambda function does. Without
  // a role the code has no credentials.
  role?: string
  sessionName?: string
  code: string
  // Wall-clock limit, default 30 s; the code's own (virtual) time is not limited.
  timeoutSeconds?: number
  // Where the emulated services answer, default http://localhost:3000.
  simulatorUrl?: string
}

// Consecutive identical connections (a client retrying) are one record.
export interface ConnectionRecord {
  host: string
  port: number
  scheme: string
  verdict: 'allow' | 'deny' | 'unknown'
  attempts: number
  // Virtual seconds since the start of the run.
  firstAt: number
  lastAt: number
  trace: Trace
}

export interface RunResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  // The time the code believes passed (sleeps and connect timeouts included), against the real time it took.
  virtualSeconds: number
  realSeconds: number
  connections: ConnectionRecord[]
  // IP connections the shim cannot see; refused.
  unmodelled: { host: string; port: number; at: number }[]
  assumptions: string[]
  identity?: string
  text: string
}

export class BadRunRequest extends Error {}

const MAX_OUTPUT = 64 * 1024
const SHIM = join(process.cwd(), 'src/app/api/runtime/netshim.py')
const PASSED_ENVIRONMENT = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'PYENV_ROOT', 'PYENV_VERSION', 'VIRTUAL_ENV']

const asList = (value: unknown): string[] => ([] as string[]).concat((value as string[]) ?? [])

// A role can be assumed by a service when its trust policy allows the service principal, as for a Lambda function.
function trustsService(role: iam.Role, service: string): boolean {
  const statements: { Effect?: string; Action?: unknown; Principal?: { Service?: unknown } }[] = ([] as never[]).concat(role.assumeRolePolicyDocument.Statement as never)
  const applicable = statements.filter(s =>
    asList(s.Action).some(a => a === '*' || a === 'sts:*' || a === 'sts:AssumeRole') && asList(s.Principal?.Service).includes(service))
  return applicable.some(s => s.Effect === 'Allow') && !applicable.some(s => s.Effect === 'Deny')
}

function credentialsFor(account: string, roleName: string, sessionName: string) {
  const role = iam.findRole(account, roleName)
  if (!role) {
    throw new BadRunRequest(`No role '${roleName}' in account ${account}`)
  }
  if (!trustsService(role, 'lambda.amazonaws.com')) {
    throw new BadRunRequest(`The trust policy of role '${roleName}' does not allow lambda.amazonaws.com to assume it`)
  }
  const arn = `arn:aws:sts::${account}:assumed-role/${roleName}/${sessionName}`
  const session = issueSession(account, arn, `${role.roleId}:${sessionName}`, 3600)
  return { arn, session }
}

interface Decision {
  verdict: 'allow' | 'deny' | 'unknown'
  message: string
  trace: Trace
}

function decide(scope: { account: string; region: string }, source: Source, host: string, port: number): Decision {
  const trace = reachPublicService(loadState(scope), source, { host, port })
  if (trace.outcome === 'reached') {
    return { verdict: 'allow', message: '', trace }
  }
  if (trace.outcome === 'failed') {
    const failed = trace.steps.find(s => s.phase === trace.failedAt)
    return { verdict: 'deny', message: `${trace.cause}: ${failed?.summary ?? 'the connection is blocked'}`, trace }
  }
  const unmodelled = trace.steps.find(s => s.decision === 'not-modelled')
  return { verdict: 'unknown', message: `not modelled: ${unmodelled?.summary ?? 'part of the path'}`, trace }
}

const seconds = (value: number) => `${value.toFixed(value < 10 ? 1 : 0)} s`

function report(result: Omit<RunResult, 'text'>): string {
  const lines: string[] = [`exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}; the code saw ${seconds(result.virtualSeconds)}, it took ${seconds(result.realSeconds)}`]
  if (result.identity) {
    lines.push(`running as ${result.identity}`)
  }
  result.connections.forEach((c, index) => {
    const times = c.attempts > 1 ? `${c.attempts} attempts, ${seconds(c.firstAt)} to ${seconds(c.lastAt)}` : `at ${seconds(c.firstAt)}`
    lines.push('', `connection ${index + 1}: ${c.scheme}://${c.host}:${c.port} (${times})`, renderTrace(c.trace))
  })
  for (const u of result.unmodelled) {
    lines.push('', `refused: the code opened a connection to ${u.host}:${u.port} (at ${seconds(u.at)}) that the shim cannot see; not modelled`)
  }
  return lines.join('\n')
}

export async function runInContext(request: RunRequest): Promise<RunResult> {
  if (!request.account || !accountDirExists(request.account)) {
    throw new BadRunRequest(`Unknown account '${request.account}'`)
  }
  if (!request.region) {
    throw new BadRunRequest('A region is required')
  }
  if (typeof request.code !== 'string' || request.code === '') {
    throw new BadRunRequest('No code to run')
  }
  const scope = { account: request.account, region: request.region }
  let resolved
  try {
    resolved = resolveSource(loadState(scope), request.from ?? {})
  } catch (error) {
    throw error instanceof BadReachRequest ? new BadRunRequest(error.message) : error
  }
  const { source, assumptions } = resolved
  const simulator = new URL(request.simulatorUrl ?? 'http://localhost:3000')

  const env: Record<string, string> = {
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    // The code must not find a profile, an endpoint override or instance metadata of the machine it really runs on.
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_REGION: request.region,
    AWS_DEFAULT_REGION: request.region,
    // as in Lambda: the SDK uses the regional STS endpoint, not sts.amazonaws.com
    AWS_STS_REGIONAL_ENDPOINTS: 'regional',
    JPK_SIM_HOST: simulator.hostname,
    JPK_SIM_PORT: simulator.port || (simulator.protocol === 'https:' ? '443' : '80'),
  }
  for (const name of PASSED_ENVIRONMENT) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name]!
    }
  }
  let identity: string | undefined
  if (request.role) {
    const { arn, session } = credentialsFor(request.account, request.role, request.sessionName ?? 'run')
    identity = arn
    Object.assign(env, { AWS_ACCESS_KEY_ID: session.keyId, AWS_SECRET_ACCESS_KEY: session.secret, AWS_SESSION_TOKEN: session.sessionToken })
  }

  const directory = mkdtempSync(join(tmpdir(), 'jpk-run-'))
  const script = join(directory, 'main.py')
  writeFileSync(script, request.code)
  const started = Date.now()
  const connections: ConnectionRecord[] = []
  const unmodelled: RunResult['unmodelled'] = []
  let virtualSeconds = 0
  let stdout = ''
  let stderr = ''
  let timedOut = false

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const stdio: StdioOptions = ['ignore', 'pipe', 'pipe', 'pipe']
      const child = spawn(process.env.JPK_PYTHON ?? 'python3', [SHIM, script], { env: env as NodeJS.ProcessEnv, cwd: directory, stdio })
      const channel = child.stdio[3] as Duplex
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, (request.timeoutSeconds ?? 30) * 1000)

      child.stdout!.on('data', chunk => { stdout = (stdout + chunk).slice(0, MAX_OUTPUT) })
      child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(0, MAX_OUTPUT) })

      let pending = ''
      channel.on('data', chunk => {
        pending += chunk
        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
          handle(JSON.parse(pending.slice(0, end)))
          pending = pending.slice(end + 1)
        }
      })
      channel.on('error', () => undefined)

      const handle = (message: { op: string; host: string; port: number; scheme: string; at: number }) => {
        virtualSeconds = Math.max(virtualSeconds, message.at)
        if (message.op === 'unmodelled') {
          unmodelled.push({ host: message.host, port: message.port, at: message.at })
        } else if (message.op === 'connect') {
          const decision = decide(scope, source, message.host, message.port)
          const last = connections.at(-1)
          if (last && last.host === message.host && last.port === message.port && last.verdict === decision.verdict && last.trace.cause === decision.trace.cause) {
            last.attempts++
            last.lastAt = message.at
          } else {
            connections.push({ host: message.host, port: message.port, scheme: message.scheme, verdict: decision.verdict, attempts: 1, firstAt: message.at, lastAt: message.at, trace: decision.trace })
          }
          channel.write(JSON.stringify({ verdict: decision.verdict, message: decision.message }) + '\n')
        }
      }

      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => { clearTimeout(timer); resolve(code) })
    })

    const result = {
      exitCode, timedOut, stdout, stderr, virtualSeconds, realSeconds: (Date.now() - started) / 1000,
      connections, unmodelled, assumptions, identity,
    }
    return { ...result, text: report(result) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
