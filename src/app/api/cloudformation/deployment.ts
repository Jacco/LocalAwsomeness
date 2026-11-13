import { execFileSync, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import path from 'path'
import { createInterface } from 'readline'
import type { ServiceCaller } from '../kms/service-use'
import { deploymentSession } from './role'
import { appendStackEvent, deleteStack, getStack, getStackTemplate, saveStack, type Stack, type StackResource } from './storage'

// Runs the Python deployment engine (python/cf_deploy.py) for a stack operation and follows its JSON-line events:
// resource events update Stack.Resources and are recorded as stack events (DescribeStackEvents); the final event sets
// the stack status and the resource state that is passed back to the engine next time. The operation returns at
// once, as in AWS; clients poll DescribeStacks (aws cloudformation wait stack-create-complete).

export type Operation = 'CREATE' | 'UPDATE' | 'DELETE'

interface EngineEvent {
  stage: string
  message?: string
  resource?: string
  status?: string
  resourceType?: string
  physicalId?: string
  reason?: string
  stackStatus?: Stack['StackStatus']
  resources?: Record<string, { type: string; physicalId: string; properties?: Record<string, unknown> }>
}

let interpreter: string | undefined

// An interpreter that can run the engine: JPK_PYTHON, or the first python3.x >= 3.10 with boto3 (the parser uses
// `match`; the macOS /usr/bin/python3 is 3.9).
function pythonExecutable(): string {
  if (process.env.JPK_PYTHON) return process.env.JPK_PYTHON
  if (interpreter) return interpreter
  for (const candidate of ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3']) {
    try {
      execFileSync(candidate, ['-c', 'import sys, boto3; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { stdio: 'ignore', timeout: 15000 })
      interpreter = candidate
      return candidate
    } catch {
      // try the next one
    }
  }
  throw new Error('No Python >= 3.10 with boto3 found to run the deployment engine; set JPK_PYTHON')
}

function engineScript(): string {
  return process.env.JPK_CF_ENGINE ?? path.join(process.cwd(), 'python', 'cf_deploy.py')
}

const RESOURCE_STAGES = new Set(['EXECUTE', 'CLEANUP', 'ROLLBACK'])
const IN_PROGRESS: Record<Operation, Stack['StackStatus']> = { CREATE: 'CREATE_IN_PROGRESS', UPDATE: 'UPDATE_IN_PROGRESS', DELETE: 'DELETE_IN_PROGRESS' }
const FAILED: Record<Operation, Stack['StackStatus']> = { CREATE: 'CREATE_FAILED', UPDATE: 'UPDATE_FAILED', DELETE: 'DELETE_FAILED' }

export interface DeploymentRequest {
  account: string
  region: string
  stackName: string
  operation: Operation
  caller: ServiceCaller & { userId: string }
  // DeleteStack can name a role of its own; otherwise the stack's.
  roleArn?: string
}

// Starts the deployment and returns when the engine has been started; failures to start set the stack's status.
// Resolves with a promise for the end of the deployment (for tests and callers that want to wait).
export async function startDeployment(request: DeploymentRequest): Promise<{ done: Promise<void> }> {
  const { account, stackName, operation } = request
  const stack = await getStack(account, stackName)
  await setStatus(account, stackName, IN_PROGRESS[operation], undefined, 'User Initiated')
  try {
    const roleArn = request.roleArn ?? stack.RoleARN
    const session = deploymentSession(request.caller, roleArn)
    const config = {
      stackName,
      account,
      region: request.region,
      operation,
      ...(operation !== 'DELETE' && { templateBody: await getStackTemplate(account, stackName, request.caller) }),
      parameters: stack.Parameters,
      previousResources: stack.__deployed ?? {},
      disableRollback: stack.DisableRollback ?? false,
      endpointUrl: process.env.JPK_ENDPOINT_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
      credentials: session.credentials,
      ...(roleArn && { roleArn }),
    }
    return { done: run(account, stackName, operation, config) }
  } catch (e) {
    await setStatus(account, stackName, FAILED[operation], (e as Error).message)
    return { done: Promise.resolve() }
  }
}

function run(account: string, stackName: string, operation: Operation, config: Record<string, unknown>): Promise<void> {
  return new Promise(resolve => {
    let queue = Promise.resolve()
    let final: EngineEvent | undefined
    let stderr = ''
    const enqueue = (work: () => Promise<void>) => {
      queue = queue.then(work).catch(e => console.error(`[cloudformation] ${stackName}:`, e))
    }

    let child
    try {
      child = spawn(pythonExecutable(), [engineScript(), '-'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } })
    } catch (e) {
      enqueue(() => setStatus(account, stackName, FAILED[operation], `The deployment engine could not be started: ${(e as Error).message}`))
      queue.then(resolve)
      return
    }
    child.stdin.end(JSON.stringify(config))
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
    createInterface({ input: child.stdout }).on('line', line => {
      let event: EngineEvent
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event.stage === 'SUCCESS' || event.stage === 'ERROR') {
        final = event
      }
      enqueue(() => handleEvent(account, stackName, operation, event))
    })
    child.on('error', e => { stderr += `\n${e.message}` })
    child.on('close', code => {
      enqueue(async () => {
        if (!final) {
          await setStatus(account, stackName, FAILED[operation], `The deployment engine exited with code ${code} without a result: ${stderr.trim().split('\n').slice(-3).join(' | ')}`)
        } else if (operation === 'DELETE' && final.stackStatus === 'DELETE_COMPLETE') {
          await deleteStack(account, stackName)
        }
      })
      queue.then(resolve)
    })
  })
}

async function handleEvent(account: string, stackName: string, operation: Operation, event: EngineEvent): Promise<void> {
  const stack = await getStack(account, stackName)
  // Resource events of the deployment itself; the parser's per-resource events (PARSE) are not stack events.
  if (event.resource && event.status && RESOURCE_STAGES.has(event.stage)) {
    await appendStackEvent(account, {
      EventId: randomUUID(), StackId: stack.StackId, StackName: stackName, LogicalResourceId: event.resource,
      PhysicalResourceId: event.physicalId, ResourceType: event.resourceType ?? '', Timestamp: Date.now(),
      ResourceStatus: event.status, ...(event.reason && { ResourceStatusReason: event.reason }),
    })
    // Cleanup deletes replaced resources (another physical ID under the same logical ID) and removed ones.
    if (event.stage !== 'CLEANUP') {
      upsertResource(stack, event)
      await saveStack(account, stack)
    }
    return
  }
  if (event.stage === 'ROLLBACK') {
    await setStatus(account, stackName, operation === 'CREATE' ? 'ROLLBACK_IN_PROGRESS' : 'UPDATE_ROLLBACK_IN_PROGRESS', event.message)
    return
  }
  if (event.stage === 'SUCCESS' || event.stage === 'ERROR') {
    const fresh = await getStack(account, stackName)
    if (event.resources) {
      fresh.__deployed = event.resources
      if (event.stage === 'SUCCESS') {
        fresh.Resources = Object.entries(event.resources).map(([logicalId, r]) => {
          const last = fresh.Resources.find(x => x.LogicalResourceId === logicalId)
          return {
            LogicalResourceId: logicalId, PhysicalResourceId: r.physicalId, ResourceType: r.type,
            ResourceStatus: last?.ResourceStatus ?? `${operation}_COMPLETE` as StackResource['ResourceStatus'],
            Timestamp: last?.Timestamp ?? Date.now(),
          }
        })
      }
    }
    await saveStack(account, fresh)
    await setStatus(account, stackName, event.stackStatus ?? (event.stage === 'SUCCESS' ? `${operation}_COMPLETE` as Stack['StackStatus'] : FAILED[operation]),
      event.stage === 'ERROR' ? event.message : undefined)
  }
}

function upsertResource(stack: Stack, event: EngineEvent) {
  const resource: StackResource = {
    LogicalResourceId: event.resource!,
    PhysicalResourceId: event.physicalId ?? '',
    ResourceType: event.resourceType ?? '',
    ResourceStatus: event.status as StackResource['ResourceStatus'],
    Timestamp: Date.now(),
    ...(event.reason && { StatusReason: event.reason }),
  }
  const index = stack.Resources.findIndex(r => r.LogicalResourceId === resource.LogicalResourceId)
  if (index >= 0) {
    stack.Resources[index] = { ...stack.Resources[index], ...resource, PhysicalResourceId: resource.PhysicalResourceId || stack.Resources[index].PhysicalResourceId }
  } else {
    stack.Resources.push(resource)
  }
}

// Sets the stack status and records it as a stack event, as CloudFormation does for the stack itself.
async function setStatus(account: string, stackName: string, status: Stack['StackStatus'], reason?: string, eventReason?: string) {
  const stack = await getStack(account, stackName)
  stack.StackStatus = status
  if (reason) {
    stack.StackStatusReason = reason
  } else {
    delete stack.StackStatusReason
  }
  stack.LastUpdatedTime = Date.now()
  await saveStack(account, stack)
  await appendStackEvent(account, {
    EventId: randomUUID(), StackId: stack.StackId, StackName: stackName, LogicalResourceId: stackName,
    PhysicalResourceId: stack.StackId, ResourceType: 'AWS::CloudFormation::Stack', Timestamp: Date.now(),
    ResourceStatus: status, ...((reason ?? eventReason) && { ResourceStatusReason: reason ?? eventReason }),
  })
}
