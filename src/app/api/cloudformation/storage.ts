import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'

const dbPath = join(process.cwd(), 'db')

export interface StackParameter {
  ParameterKey: string
  ParameterValue: string
}

export interface StackResource {
  LogicalResourceId: string
  PhysicalResourceId: string
  ResourceType: string
  ResourceStatus: 'CREATE_IN_PROGRESS' | 'CREATE_COMPLETE' | 'CREATE_FAILED' |
                   'UPDATE_IN_PROGRESS' | 'UPDATE_COMPLETE' | 'UPDATE_FAILED' |
                   'DELETE_IN_PROGRESS' | 'DELETE_COMPLETE' | 'DELETE_FAILED'
  Timestamp: number
  StatusReason?: string
  Properties?: Record<string, any>
}

export interface Stack {
  StackId: string
  StackName: string
  Description?: string
  Parameters?: StackParameter[]
  CreationTime: number
  LastUpdatedTime?: number
  StackStatus: 'CREATE_IN_PROGRESS' | 'CREATE_COMPLETE' | 'CREATE_FAILED' |
               'UPDATE_IN_PROGRESS' | 'UPDATE_COMPLETE' | 'UPDATE_FAILED' |
               'DELETE_IN_PROGRESS' | 'DELETE_COMPLETE' | 'DELETE_FAILED' |
               'ROLLBACK_IN_PROGRESS' | 'ROLLBACK_COMPLETE'
  StackStatusReason?: string
  Tags?: Array<{ Key: string; Value: string }>
  TimeoutInMinutes?: number
  NotificationARNs?: string[]
  DisableRollback?: boolean
  Capabilities?: string[]
  RoleARN?: string
  EnableTerminationProtection: boolean
  Resources: StackResource[]
  TemplateBody?: string
  Outputs?: Array<{ OutputKey: string; OutputValue: string; Description?: string; ExportName?: string }>
}

export interface Template {
  TemplateBody: string
  TemplateDescription?: string
  Version?: string
  Resources: Record<string, {
    Type: string
    Properties?: Record<string, any>
    DependsOn?: string | string[]
    Description?: string
    CreationPolicy?: any
    UpdateReplacePolicy?: string
  }>
  Parameters?: Record<string, {
    Type: string
    Default?: any
    Description?: string
    AllowedValues?: any[]
    AllowedPattern?: string
    ConstraintDescription?: string
  }>
  Outputs?: Record<string, {
    Value: string | { 'Fn::GetAtt'?: [string, string]; 'Fn::Ref'?: string }
    Export?: { Name: string }
    Description?: string
  }>
  Exports?: Record<string, any>
  Conditions?: Record<string, any>
  Metadata?: Record<string, any>
}

/**
 * Store template and validate JSON structure
 * @throws ValidationException if template is invalid JSON or missing required sections
 */
export async function storeTemplate(
  account: string,
  templateBody: string
): Promise<{ TemplateDescription: string; Version: string; Resources: Record<string, any>; Parameters?: Record<string, any> }> {
  let parsed: Template
  try {
    parsed = JSON.parse(templateBody)
  } catch (e) {
    throw new Error('Template body must be valid JSON')
  }

  if (!parsed.Resources || typeof parsed.Resources !== 'object' || Object.keys(parsed.Resources).length === 0) {
    throw new Error('Template must declare at least one resource')
  }

  return {
    TemplateDescription: parsed.TemplateDescription || '',
    Version: parsed.Version || '2010-09-09',
    Resources: parsed.Resources,
    Parameters: parsed.Parameters
  }
}

/**
 * Create a new stack in the database
 * Stack ID format: arn:aws:cloudformation:region:account:stack/name/uuid
 */
export async function createStack(
  account: string,
  stackName: string,
  templateBody: string,
  parameters?: StackParameter[],
  tags?: Array<{ Key: string; Value: string }>,
  options?: {
    description?: string
    timeoutInMinutes?: number
    notificationARNs?: string[]
    disableRollback?: boolean
    capabilities?: string[]
    roleARN?: string
  }
): Promise<string> {
  const template = await storeTemplate(account, templateBody)
  
  const stackId = randomUUID()
  const stackArn = `arn:aws:cloudformation:eu-central-1:${account}:stack/${stackName}/${stackId}`
  
  const stack: Stack = {
    StackId: stackArn,
    StackName: stackName,
    Description: options?.description || template.TemplateDescription,
    Parameters: parameters || [],
    CreationTime: Date.now(),
    StackStatus: 'CREATE_IN_PROGRESS',
    EnableTerminationProtection: false,
    Resources: [],
    Tags: tags,
    TimeoutInMinutes: options?.timeoutInMinutes,
    NotificationARNs: options?.notificationARNs,
    DisableRollback: options?.disableRollback ?? false,
    Capabilities: options?.capabilities,
    RoleARN: options?.roleARN,
  }

  const stackDir = join(dbPath, account, 'cloudformation', 'stacks')
  await mkdir(stackDir, { recursive: true })
  
  const stackPath = join(stackDir, `${stackName}.json`)
  await writeFile(stackPath, JSON.stringify(stack, null, 2))

  const templateDir = join(dbPath, account, 'cloudformation', 'templates')
  await mkdir(templateDir, { recursive: true })
  const templatePath = join(templateDir, `${stackName}.json`)
  await writeFile(templatePath, templateBody)

  return stackArn
}

/**
 * Retrieve stack by name or ARN
 */
export async function getStack(account: string, stackNameOrId: string): Promise<Stack> {
  // Extract stack name from ARN if provided
  let stackName = stackNameOrId
  if (stackNameOrId.startsWith('arn:')) {
    const match = stackNameOrId.match(/stack\/([^/]+)\//)
    if (!match) throw new Error('Invalid stack ARN format')
    stackName = match[1]
  }

  const stackPath = join(dbPath, account, 'cloudformation', 'stacks', `${stackName}.json`)
  
  if (!existsSync(stackPath)) {
    throw new Error(`Stack with id [${stackNameOrId}] does not exist`)
  }

  const content = await readFile(stackPath, 'utf-8')
  return JSON.parse(content)
}

/**
 * List all stacks for an account (optionally filtered by status)
 */
export async function listStacks(
  account: string,
  stackStatusFilter?: string[]
): Promise<Stack[]> {
  const stackDir = join(dbPath, account, 'cloudformation', 'stacks')
  
  if (!existsSync(stackDir)) {
    return []
  }

  const files = require('fs').readdirSync(stackDir).filter((f: string) => f.endsWith('.json'))
  const stacks = await Promise.all(
    files.map(async (file: string) => {
      const content = await readFile(join(stackDir, file), 'utf-8')
      return JSON.parse(content) as Stack
    })
  )

  if (stackStatusFilter && stackStatusFilter.length > 0) {
    return stacks.filter(s => stackStatusFilter.includes(s.StackStatus))
  }

  return stacks
}

/**
 * Update stack status (for lifecycle management)
 */
export async function updateStackStatus(
  account: string,
  stackName: string,
  status: Stack['StackStatus'],
  reason?: string
): Promise<void> {
  const stack = await getStack(account, stackName)
  
  stack.StackStatus = status
  stack.StackStatusReason = reason
  stack.LastUpdatedTime = Date.now()

  const stackPath = join(dbPath, account, 'cloudformation', 'stacks', `${stackName}.json`)
  await writeFile(stackPath, JSON.stringify(stack, null, 2))
}

/**
 * Add resource to stack (during execution)
 */
export async function addStackResource(
  account: string,
  stackName: string,
  resource: StackResource
): Promise<void> {
  const stack = await getStack(account, stackName)
  
  const existing = stack.Resources.findIndex(r => r.LogicalResourceId === resource.LogicalResourceId)
  if (existing >= 0) {
    stack.Resources[existing] = resource
  } else {
    stack.Resources.push(resource)
  }

  const stackPath = join(dbPath, account, 'cloudformation', 'stacks', `${stackName}.json`)
  await writeFile(stackPath, JSON.stringify(stack, null, 2))
}

/**
 * Get stack resources
 */
export async function getStackResources(
  account: string,
  stackName: string
): Promise<StackResource[]> {
  const stack = await getStack(account, stackName)
  return stack.Resources
}

/**
 * Get template used to create/update stack
 */
export async function getTemplate(
  account: string,
  stackName: string
): Promise<string> {
  const templatePath = join(dbPath, account, 'cloudformation', 'templates', `${stackName}.json`)
  
  if (!existsSync(templatePath)) {
    throw new Error(`Stack with id [${stackName}] does not exist`)
  }

  return await readFile(templatePath, 'utf-8')
}

/**
 * Delete stack and associated data
 */
export async function deleteStack(account: string, stackName: string): Promise<void> {
  const { readdir, unlink } = require('fs/promises')
  const fs = require('fs')

  const stack = await getStack(account, stackName)
  
  const stackPath = join(dbPath, account, 'cloudformation', 'stacks', `${stackName}.json`)
  const templatePath = join(dbPath, account, 'cloudformation', 'templates', `${stackName}.json`)

  if (fs.existsSync(stackPath)) {
    await unlink(stackPath)
  }
  if (fs.existsSync(templatePath)) {
    await unlink(templatePath)
  }

  stack.StackStatus = 'DELETE_COMPLETE'
  stack.LastUpdatedTime = Date.now()
}

/**
 * Get stack outputs (from completed resources)
 */
export async function getStackOutputs(
  account: string,
  stackName: string
): Promise<Array<{ OutputKey: string; OutputValue: string; Description?: string; ExportName?: string }>> {
  const stack = await getStack(account, stackName)
  return stack.Outputs || []
}

/**
 * Add stack output
 */
export async function addStackOutput(
  account: string,
  stackName: string,
  output: { OutputKey: string; OutputValue: string; Description?: string; ExportName?: string }
): Promise<void> {
  const stack = await getStack(account, stackName)
  
  if (!stack.Outputs) {
    stack.Outputs = []
  }

  const existing = stack.Outputs.findIndex(o => o.OutputKey === output.OutputKey)
  if (existing >= 0) {
    stack.Outputs[existing] = output
  } else {
    stack.Outputs.push(output)
  }

  const stackPath = join(dbPath, account, 'cloudformation', 'stacks', `${stackName}.json`)
  await writeFile(stackPath, JSON.stringify(stack, null, 2))
}

/**
 * Export lookup (for cross-stack imports)
 */
export async function lookupExport(account: string, exportName: string): Promise<string | null> {
  const stacks = await listStacks(account)
  
  for (const stack of stacks) {
    const output = stack.Outputs?.find(o => o.ExportName === exportName)
    if (output) {
      return output.OutputValue
    }
  }

  return null
}
