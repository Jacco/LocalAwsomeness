import { execFileSync, spawn, type StdioOptions } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Duplex } from 'stream'
import { issueSession } from '../../app/api/data/credentials'
import { contains, parseAddress, parseCidr } from '../../app/api/data/ec2/cidr'
import { loadState } from '../../app/api/data/ec2/state'
import * as iam from '../../app/api/data/iam'
import { accountDirExists } from '../../app/api/data/store'
import { BadReachRequest, resolveSource, type ReachRequest } from '../../app/api/network/live'
import { reachPublicService, type Source } from '../../app/api/network/reach'
import { renderTrace, type Step, type Trace } from '../../app/api/network/trace'

// Runs a Python script as if it were somewhere in the simulated network (docs/walking-skeleton.md, step 3b). The script
// runs in a subprocess behind the shim (netshim.py); every connection it opens is decided here by the network model, from
// the live EC2 state at that moment, and recorded with its trace. The subprocess is asynchronous on purpose: the script
// calls back into this same server, which must stay free to answer.

export interface RunRequest {
  account: string
  region: string
  // Where the code runs: the same naming as for a trace (ReachRequest.from). Without it the code runs in the AWS-managed
  // network, as a Lambda function without a VPC does: public addresses are reachable, private ones are not.
  from?: ReachRequest['from']
  // The execution role: the code gets the credentials of a session of this role, as a Lambda function does. Without
  // a role the code has no credentials.
  role?: string
  sessionName?: string
  code: string
  // Files put next to the script (relative names), and extra environment variables; the variables the runner sets itself
  // cannot be overridden.
  files?: Record<string, string | Buffer>
  env?: Record<string, string>
  // A file the code writes (relative name); its content comes back as `output`.
  resultFile?: string
  // Wall-clock limit, default 30 s; the code's own (virtual) time is not limited, unless the next one is set.
  timeoutSeconds?: number
  // The code is stopped when its virtual clock passes this (a Lambda timeout). Sleeping and waiting for a connect timeout
  // count, so a call that retries for 30 s takes the function down at 3 s, as it would in AWS.
  virtualDeadlineSeconds?: number
  // Where the emulated services answer, default http://localhost:3000.
  simulatorUrl?: string
}

// Network context passed from netshim to runner for authorization and policy enforcement decisions.
// Extensible for future attributes like request headers, source IP, timestamp, etc.
export interface NetworkContext {
  // Service name in AWS format: com.amazonaws.region.service
  serviceName: string
  // VPC ID where the connection originates (if in VPC)
  vpcId: string
  // Subnet ID where the connection originates (if in VPC)
  subnetId: string
  // Principal ARN making the connection (Lambda execution role)
  principalArn?: string
  // Can be extended with: sourceIp, timestamp, requestId, headers, etc.
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

export interface LogNetworkDecision {
  // Whether CloudWatch Logs is reachable from the Lambda execution context
  reachable: 'allow' | 'deny' | 'unknown'
  reason: string
  trace: Trace
}

export interface RunResult {
  exitCode: number | null
  timedOut: boolean
  // The virtual deadline was passed: the code was stopped there.
  virtualTimedOut: boolean
  stdout: string
  stderr: string
  // Standard output and error in the order they were written.
  log: string
  // The content of the result file, when the request named one and the code wrote it.
  output?: string
  // The time the code believes passed (sleeps and connect timeouts included), against the real time it took.
  virtualSeconds: number
  realSeconds: number
  connections: ConnectionRecord[]
  // IP connections the shim cannot see; refused.
  unmodelled: { host: string; port: number; at: number }[]
  assumptions: string[]
  identity?: string
  // Network decision for CloudWatch Logs reachability (if logging was captured)
  logNetworkDecision?: LogNetworkDecision
  text: string
}

export class BadRunRequest extends Error {}

const MAX_OUTPUT = 64 * 1024
const SHIM = join(process.cwd(), 'src/lib/lambda-runtime/netshim.py')
const PASSED_ENVIRONMENT = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'PYENV_ROOT', 'PYENV_VERSION', 'VIRTUAL_ENV']

// The interpreter to run, resolved once: `python3` is often a shim (pyenv) that costs about 0.6 s on every start, while the
// interpreter behind it starts in 0.04 s. JPK_PYTHON overrides.
let interpreter: string | undefined
function pythonExecutable(): string {
  if (process.env.JPK_PYTHON) {
    return process.env.JPK_PYTHON
  }
  if (!interpreter) {
    try {
      interpreter = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim() || 'python3'
    } catch {
      interpreter = 'python3'
    }
  }
  return interpreter
}

function credentialsFor(account: string, roleName: string, sessionName: string) {
  const role = iam.findRole(account, roleName)
  if (!role) {
    throw new BadRunRequest(`No role '${roleName}' in account ${account}`)
  }
  if (!iam.trustsService(role, 'lambda.amazonaws.com')) {
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

const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'].map(c => parseCidr(c)!)

// Resolves a VPC endpoint for the given service and VPC, if it exists.
function resolveVpcEndpoint(
  state: ReturnType<typeof loadState>,
  serviceName: string,
  vpcId: string
): { id: string; endpoint: any } | null {
  if (!state.vpcEndpoints) {
    return null
  }
  for (const [id, endpoint] of Object.entries(state.vpcEndpoints)) {
    if (endpoint.ServiceName === serviceName && endpoint.VpcId === vpcId && endpoint.State === 'available') {
      return { id, endpoint }
    }
  }
  return null
}

// Evaluate VPC endpoint resource-based policy to determine if a principal can access the endpoint.
// If no policy is present, allow all principals (default open access).
function evaluateVpcEndpointPolicy(
  endpoint: any,
  context: NetworkContext
): { allowed: boolean; reason: string; detail: string } {
  // If no policy is defined, allow access (backward compatible)
  if (!endpoint.PolicyDocument) {
    return { allowed: true, reason: 'No policy attached to VPC endpoint', detail: 'VPC endpoint has no policy; access is allowed by default.' }
  }

  const policy = endpoint.PolicyDocument
  const principal = context.principalArn || '*'
  const serviceName = context.serviceName

  // Get statements from policy
  const statements = (policy.Statement || []) as Record<string, any>[]
  
  // Check for explicit deny
  for (const statement of statements) {
    if (statement.Effect === 'Deny' && statementAppliesToPrincipal(statement, principal)) {
      return {
        allowed: false,
        reason: `VPC endpoint policy explicitly denies access to principal ${principal}`,
        detail: `Statement '${statement.Sid || '(unnamed)'}' denies access.`
      }
    }
  }

  // Check for allow
  for (const statement of statements) {
    if (statement.Effect === 'Allow' && statementAppliesToPrincipal(statement, principal)) {
      return {
        allowed: true,
        reason: `VPC endpoint policy allows access to principal ${principal}`,
        detail: `Statement '${statement.Sid || '(unnamed)'}' grants access.`
      }
    }
  }

  // No matching allow statement
  return {
    allowed: false,
    reason: `VPC endpoint policy does not allow access to principal ${principal}`,
    detail: `No Allow statement in the policy matches the principal. Implicit deny.`
  }
}

// Check if a policy statement applies to a principal (supports wildcards and ARN format).
function statementAppliesToPrincipal(statement: Record<string, any>, principal: string): boolean {
  const principals = statement.Principal || []
  const principalList = Array.isArray(principals) ? principals : (typeof principals === 'object' ? [principals] : [principals])
  
  for (const p of principalList) {
    // Handle "*" wildcard
    if (p === '*') return true
    // Handle principal as string (ARN)
    if (typeof p === 'string') {
      if (p === principal) return true
      // Support wildcards in principal ARN (e.g., arn:aws:iam::111111111111:role/*)
      if (wildcardMatchArn(p, principal)) return true
    }
  }
  return false
}

// Match ARNs with wildcard support.
function wildcardMatchArn(pattern: string, text: string): boolean {
  const escape = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`^${escape(pattern).replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
  return regex.test(text)
}

// Code that is not in a VPC runs in the AWS-managed network: public addresses are reachable directly, the private
// addresses of customer VPCs are not (there is no route to them).
function decideUnattached(host: string, port: number, scheme: string): Decision {
  const address = parseAddress(host)
  const intent = `${scheme === 'https' ? 'HTTPS' : `tcp/${port}`} to ${host}:${port}`
  const base = { from: 'the function (not in a VPC)', to: `${host}:${port}`, intent, problems: [] as Trace['problems'] }
  if (address !== undefined && PRIVATE_RANGES.some(range => contains(range, { address, prefix: 32 }))) {
    const summary = `${host} is a private address and the code is not in a VPC, so there is no route to it`
    const step: Step = { phase: 'route', decision: 'deny', summary, detail: ['A function without a VPC runs in a network managed by AWS, outside every customer VPC.'], evidence: [], cause: 'no-route' }
    const trace: Trace = {
      ...base, outcome: 'failed', observed: 'connect-timeout', steps: [step], failedAt: 'route', cause: 'no-route',
      problems: [{ phase: 'route', cause: 'no-route', summary }], hint: 'attach the function to a VPC (VpcConfig) to reach private addresses',
    }
    return { verdict: 'deny', message: `no-route: ${summary}`, trace }
  }
  const step: Step = {
    phase: 'delivery', decision: 'allow', summary: `delivered to ${host}`,
    detail: ['A function without a VPC runs in a network managed by AWS with direct access to public addresses; no customer security group, network ACL or route table applies.'], evidence: [],
  }
  const trace: Trace = { ...base, outcome: 'reached', observed: 'reached', steps: [step], context: { path: 'aws-managed' } }
  return { verdict: 'allow', message: '', trace }
}

function decide(scope: { account: string; region: string }, source: Source | undefined, host: string, port: number, scheme: string): Decision {
  if (!source) {
    return decideUnattached(host, port, scheme)
  }
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
  const lines: string[] = [`exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}${result.virtualTimedOut ? ' (stopped at the virtual deadline)' : ''}; the code saw ${seconds(result.virtualSeconds)}, it took ${seconds(result.realSeconds)}`]
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
  let source: Source | undefined
  let assumptions: string[] = []
  if (request.from) {
    try {
      ;({ source, assumptions } = resolveSource(loadState(scope), request.from))
    } catch (error) {
      throw error instanceof BadReachRequest ? new BadRunRequest(error.message) : error
    }
  }
  const simulator = new URL(request.simulatorUrl ?? 'http://localhost:3000')

  const env: Record<string, string> = {
    ...request.env,
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
  // If Lambda runs in a VPC, pass VPC context for VPC endpoint resolution
  if (source) {
    const subnet = loadState(scope).subnets[source.subnetId]
    if (subnet) {
      env.JPK_VPC_ID = subnet.VpcId
      env.JPK_SUBNET_ID = subnet.SubnetId
    }
  }
  if (request.virtualDeadlineSeconds !== undefined) {
    env.JPK_DEADLINE = String(request.virtualDeadlineSeconds)
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
  for (const [name, content] of Object.entries(request.files ?? {})) {
    if (name.startsWith('/') || name.split('/').includes('..')) {
      throw new BadRunRequest(`File name '${name}' is not relative`)
    }
    writeFileSync(join(directory, name), content)
  }
  const started = Date.now()
  const connections: ConnectionRecord[] = []
  const unmodelled: RunResult['unmodelled'] = []
  let virtualSeconds = 0
  let stdout = ''
  let stderr = ''
  let log = ''
  let timedOut = false
  let virtualTimedOut = false
  let logNetworkDecision: LogNetworkDecision | undefined

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const stdio: StdioOptions = ['ignore', 'pipe', 'pipe', 'pipe']
      const child = spawn(pythonExecutable(), [SHIM, script], { env: env as NodeJS.ProcessEnv, cwd: directory, stdio })
      const channel = child.stdio[3] as Duplex
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, (request.timeoutSeconds ?? 30) * 1000)

      child.stdout!.on('data', chunk => {
        stdout = (stdout + chunk).slice(0, MAX_OUTPUT)
        log = (log + chunk).slice(0, MAX_OUTPUT)
      })
      child.stderr!.on('data', chunk => {
        stderr = (stderr + chunk).slice(0, MAX_OUTPUT)
        log = (log + chunk).slice(0, MAX_OUTPUT)
      })

      let pending = ''
      channel.on('data', chunk => {
        pending += chunk
        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
          handle(JSON.parse(pending.slice(0, end)))
          pending = pending.slice(end + 1)
        }
      })
      channel.on('error', () => undefined)

      const handle = (message: { op: string; host?: string; port?: number; scheme?: string; networkContext?: NetworkContext; at: number }) => {
        virtualSeconds = Math.max(virtualSeconds, message.at)
        if (message.op === 'deadline') {
          virtualTimedOut = true
        } else if (message.op === 'unmodelled') {
          unmodelled.push({ host: message.host!, port: message.port!, at: message.at })
        } else if (message.op === 'log_write') {
          // Simulate a logs.put_log_events call to CloudWatch Logs
          const decision = decide(scope, source, 'logs.amazonaws.com', 443, 'https')
          logNetworkDecision = {
            reachable: decision.verdict,
            reason: decision.message || 'CloudWatch Logs is reachable',
            trace: decision.trace,
          }
        } else if (message.op === 'connect') {
          let decision = decide(scope, source, message.host!, message.port!, message.scheme!)
          
          // For VPC-attached Lambdas, check VPC endpoint availability and policy
          if (message.networkContext && source) {
            const subnet = loadState(scope).subnets[source.subnetId]
            if (subnet) {
              const vpceInfo = resolveVpcEndpoint(loadState(scope), message.networkContext.serviceName, subnet.VpcId)
              if (vpceInfo) {
                // VPC endpoint exists and is available; check resource-based policy
                const policyDecision = evaluateVpcEndpointPolicy(vpceInfo.endpoint, message.networkContext)
                if (policyDecision.allowed) {
                  // Principal is allowed by policy; modify decision to show endpoint routing
                  const endpointId = vpceInfo.id
                  decision = { ...decision, verdict: 'allow', message: `routed via VPC endpoint ${endpointId}` }
                } else {
                  // Principal denied by VPC endpoint policy
                  const summary = policyDecision.reason
                  const step: Step = { phase: 'delivery', decision: 'deny', summary, detail: [policyDecision.detail], evidence: [], cause: 'policy-deny' }
                  decision = {
                    verdict: 'deny',
                    message: `policy-deny: ${summary}`,
                    trace: {
                      from: 'the function (in VPC)',
                      to: `${message.host}:${message.port}`,
                      intent: `${message.scheme?.toUpperCase() || 'tcp'} to ${message.host}:${message.port}`,
                      problems: [{ phase: 'delivery', cause: 'policy-deny', summary }],
                      outcome: 'failed',
                      observed: 'connect-timeout',
                      steps: [step],
                      failedAt: 'delivery',
                      cause: 'policy-deny',
                    }
                  }
                }
              } else {
                // Lambda is in VPC but no endpoint exists for this service
                // Deny unless we implement NAT gateways/internet gateways (which we haven't)
                const summary = `Lambda is in VPC but no VPC endpoint exists for ${message.networkContext.serviceName} and NAT gateway is not available`
                const step: Step = { phase: 'delivery', decision: 'deny', summary, detail: ['To reach AWS services from a VPC-attached Lambda, either create a VPC endpoint for the service or attach a NAT gateway (not yet modelled).'], evidence: [], cause: 'no-route' }
                decision = {
                  verdict: 'deny',
                  message: `no-route: ${summary}`,
                  trace: {
                    from: 'the function (in VPC)',
                    to: `${message.host}:${message.port}`,
                    intent: `${message.scheme?.toUpperCase() || 'tcp'} to ${message.host}:${message.port}`,
                    problems: [{ phase: 'delivery', cause: 'no-route', summary }],
                    outcome: 'failed',
                    observed: 'connect-timeout',
                    steps: [step],
                    failedAt: 'delivery',
                    cause: 'no-route',
                  }
                }
              }
            }
          }
          
          const last = connections.at(-1)
          if (last && last.host === message.host && last.port === message.port && last.verdict === decision.verdict && last.trace.cause === decision.trace.cause) {
            last.attempts++
            last.lastAt = message.at
          } else {
            connections.push({ host: message.host!, port: message.port!, scheme: message.scheme!, verdict: decision.verdict, attempts: 1, firstAt: message.at, lastAt: message.at, trace: decision.trace })
          }
          channel.write(JSON.stringify({ verdict: decision.verdict, message: decision.message }) + '\n')
        }
      }

      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => { clearTimeout(timer); resolve(code) })
    })

    let output: string | undefined
    if (request.resultFile && existsSync(join(directory, request.resultFile))) {
      output = readFileSync(join(directory, request.resultFile), 'utf8')
    }
    const result = {
      exitCode, timedOut, virtualTimedOut, stdout, stderr, log, output, virtualSeconds, realSeconds: (Date.now() - started) / 1000,
      connections, unmodelled, assumptions, identity, logNetworkDecision,
    }
    return { ...result, text: report(result) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
