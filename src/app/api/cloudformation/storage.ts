import { randomUUID } from 'crypto'

// In-memory storage for CloudFormation stacks
const stacks = new Map<string, Stack>()
const templates = new Map<string, string>()

const getKey = (account: string, name: string) => `${account}#${name}`

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
  StackStatus: 'CREATE_IN_PROGRESS' | 'CREATE_COMPLETE' | 'CREATE_FAILED' |
               'UPDATE_IN_PROGRESS' | 'UPDATE_COMPLETE' | 'UPDATE_FAILED' |
               'DELETE_IN_PROGRESS' | 'DELETE_COMPLETE' | 'DELETE_FAILED' |
               'ROLLBACK_IN_PROGRESS' | 'ROLLBACK_COMPLETE'
  StackStatusReason?: string
  CreationTime: number
  LastUpdatedTime?: number
  Parameters: StackParameter[]
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
 * Create a new stack
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
  console.log('[CloudFormation:storage:createStack] Starting with account:', account, 'stackName:', stackName)
  
  const template = await storeTemplate(account, templateBody)
  const key = getKey(account, stackName)
  
  console.log('[CloudFormation:storage:createStack] Key:', key)
  
  // Check if stack already exists
  if (stacks.has(key)) {
    throw new Error(`Stack with name ${stackName} already exists`)
  }
  
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
  
  stacks.set(key, stack)
  templates.set(key, templateBody)
  
  return stackArn
}

/**
 * Retrieve stack by name or ARN
 */
export async function getStack(account: string, stackNameOrId: string): Promise<Stack> {
  let stackName = stackNameOrId
  if (stackNameOrId.startsWith('arn:')) {
    const match = stackNameOrId.match(/stack\/([^/]+)\//)
    if (!match) throw new Error('Invalid stack ARN format')
    stackName = match[1]
  }

  const key = getKey(account, stackName)
  const stack = stacks.get(key)
  
  if (!stack) {
    throw new Error(`Stack with id [${stackNameOrId}] does not exist`)
  }
  
  return stack
}

/**
 * List all stacks for an account
 */
export async function listStacks(
  account: string,
  stackStatusFilter?: string[]
): Promise<Stack[]> {
  const allStacks = Array.from(stacks.entries())
    .filter(([key]) => key.startsWith(`${account}#`))
    .map(([, stack]) => stack)
  
  if (stackStatusFilter && stackStatusFilter.length > 0) {
    return allStacks.filter(s => stackStatusFilter.includes(s.StackStatus))
  }
  
  return allStacks
}

/**
 * Update stack status
 */
export async function updateStackStatus(
  account: string,
  stackName: string,
  status: Stack['StackStatus'],
  reason?: string
): Promise<void> {
  const key = getKey(account, stackName)
  const stack = stacks.get(key)
  
  if (!stack) {
    throw new Error(`Stack not found: ${stackName}`)
  }
  
  stack.StackStatus = status
  stack.StackStatusReason = reason
  stack.LastUpdatedTime = Date.now()
}

/**
 * Add resource to stack
 */
export async function addStackResource(
  account: string,
  stackName: string,
  resource: StackResource
): Promise<void> {
  const key = getKey(account, stackName)
  const stack = stacks.get(key)
  
  if (!stack) {
    throw new Error(`Stack not found: ${stackName}`)
  }
  
  const existing = stack.Resources.findIndex(r => r.LogicalResourceId === resource.LogicalResourceId)
  if (existing >= 0) {
    stack.Resources[existing] = resource
  } else {
    stack.Resources.push(resource)
  }
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
 * Get template used to create stack
 */
export async function getTemplate(
  account: string,
  stackName: string
): Promise<string> {
  const key = getKey(account, stackName)
  const template = templates.get(key)
  
  if (!template) {
    throw new Error(`Stack with id [${stackName}] does not exist`)
  }
  
  return template
}

/**
 * Delete stack
 */
export async function deleteStack(account: string, stackName: string): Promise<void> {
  const key = getKey(account, stackName)
  const stack = stacks.get(key)
  
  if (!stack) {
    throw new Error(`Stack not found: ${stackName}`)
  }
  
  stack.StackStatus = 'DELETE_COMPLETE'
  stack.LastUpdatedTime = Date.now()
}

/**
 * Add stack output
 */
export async function addStackOutput(
  account: string,
  stackName: string,
  output: { OutputKey: string; OutputValue: string; Description?: string; ExportName?: string }
): Promise<void> {
  const key = getKey(account, stackName)
  const stack = stacks.get(key)
  
  if (!stack) {
    throw new Error(`Stack not found: ${stackName}`)
  }
  
  if (!stack.Outputs) {
    stack.Outputs = []
  }
  
  const existing = stack.Outputs.findIndex(o => o.OutputKey === output.OutputKey)
  if (existing >= 0) {
    stack.Outputs[existing] = output
  } else {
    stack.Outputs.push(output)
  }
}

/**
 * Export lookup for cross-stack imports
 */
export async function lookupExport(account: string, exportName: string): Promise<string | null> {
  const allStacks = await listStacks(account)
  
  for (const stack of allStacks) {
    const output = stack.Outputs?.find(o => o.ExportName === exportName)
    if (output) {
      return output.OutputValue
    }
  }
  
  return null
}
