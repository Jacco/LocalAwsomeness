import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'

// Safe data path initialization
function getDataPath(): string {
  try {
    const env = process.env.JPK_DB_ROOT
    if (env && typeof env === 'string') return env
    const cwd = process.cwd()
    if (!cwd || typeof cwd !== 'string') return '/tmp/jpk-db'
    return cwd
  } catch (e) {
    console.error('Failed to initialize data path:', e)
    return '/tmp/jpk-db'
  }
}

const DATA_ROOT = getDataPath()

// Helper to get account-specific CloudFormation directory
async function getAccountCfDir(account: string): Promise<string> {
  const dir = path.join(DATA_ROOT, 'data', 'accounts', account, 'cloudformation')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// Helper to get stacks directory
async function getStacksDir(account: string): Promise<string> {
  const dir = path.join(await getAccountCfDir(account), 'stacks')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// Helper to get a specific stack's directory
async function getStackDir(account: string, stackName: string): Promise<string> {
  const dir = path.join(await getStacksDir(account), stackName)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// Helper to get a stack's templates directory
async function getStackTemplatesDir(account: string, stackName: string): Promise<string> {
  const dir = path.join(await getStackDir(account, stackName), 'templates')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// Stack metadata file: {stackDir}/stack.json
function getStackFilePath(account: string, stackName: string): string {
  return path.join(DATA_ROOT, 'data', 'accounts', account, 'cloudformation', 'stacks', stackName, 'stack.json')
}

// Template version file: {stackDir}/templates/v{version}.json
function getTemplateVersionPath(account: string, stackName: string, version: number): string {
  return path.join(DATA_ROOT, 'data', 'accounts', account, 'cloudformation', 'stacks', stackName, 'templates', `v${version}.json`)
}

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
  Outputs?: Array<{ OutputKey: string; OutputValue: string; Description?: string; ExportName?: string }>
  // Template versioning
  TemplateVersion: number
  TemplateVersions?: number[]
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
 * Create a new stack and persist to file
 */
export async function createStack(
  account: string,
  stackName: string,
  templateBody: string,
  stackDescription?: string,
  parameters?: StackParameter[],
  tags?: Array<{ Key: string; Value: string }>,
  timeoutInMinutes?: number,
  notificationARNs?: string[],
  disableRollback?: boolean,
  capabilities?: string[],
  roleARN?: string,
  enableTerminationProtection?: boolean
): Promise<string> {
  // Validate template first
  const templateInfo = await storeTemplate(account, templateBody)

  const stackId = `arn:aws:cloudformation:us-east-1:${account}:stack/${stackName}/${randomUUID()}`
  
  const stack: Stack = {
    StackId: stackId,
    StackName: stackName,
    Description: stackDescription,
    StackStatus: 'CREATE_COMPLETE',
    CreationTime: Date.now(),
    Parameters: parameters || [],
    Tags: tags,
    TimeoutInMinutes: timeoutInMinutes,
    NotificationARNs: notificationARNs,
    DisableRollback: disableRollback ?? false,
    Capabilities: capabilities,
    RoleARN: roleARN,
    EnableTerminationProtection: enableTerminationProtection ?? false,
    Resources: [],
    Outputs: [],
    TemplateVersion: 1,
    TemplateVersions: [1]
  }

  // Create stack directory and save stack metadata
  const stackDir = await getStackDir(account, stackName)
  const stackFilePath = path.join(stackDir, 'stack.json')
  
  try {
    await fs.writeFile(stackFilePath, JSON.stringify(stack, null, 2), 'utf-8')
    console.log(`Stack metadata persisted: ${stackFilePath}`)
  } catch (e) {
    console.error(`Failed to write stack file: ${stackFilePath}`, e)
    throw new Error(`Failed to persist stack: ${(e as Error).message}`)
  }

  // Store template as versioned file
  const templatesDir = await getStackTemplatesDir(account, stackName)
  const templateVersionPath = getTemplateVersionPath(account, stackName, 1)
  
  try {
    await fs.writeFile(templateVersionPath, templateBody, 'utf-8')
    console.log(`Template v1 persisted: ${templateVersionPath}`)
  } catch (e) {
    console.error(`Failed to write template file: ${templateVersionPath}`, e)
    throw new Error(`Failed to persist template: ${(e as Error).message}`)
  }

  return stackId
}

/**
 * Retrieve stack from file (metadata only)
 */
export async function getStack(account: string, stackNameOrId: string): Promise<Stack> {
  // Extract stack name from ID if necessary
  const stackName = stackNameOrId.includes('/') 
    ? stackNameOrId.split('/')[1] 
    : stackNameOrId

  const stackFilePath = getStackFilePath(account, stackName)
  
  try {
    const data = await fs.readFile(stackFilePath, 'utf-8')
    const stack = JSON.parse(data) as Stack
    return stack
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Stack not found: ${stackName}`)
    }
    throw new Error(`Failed to read stack: ${(e as Error).message}`)
  }
}

/**
 * Retrieve stack template by version
 */
export async function getStackTemplate(
  account: string,
  stackName: string,
  version?: number
): Promise<string> {
  const stack = await getStack(account, stackName)
  const templateVersion = version ?? stack.TemplateVersion
  
  const templatePath = getTemplateVersionPath(account, stackName, templateVersion)
  
  try {
    const templateBody = await fs.readFile(templatePath, 'utf-8')
    return templateBody
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Template version ${templateVersion} not found for stack ${stackName}`)
    }
    throw new Error(`Failed to read template: ${(e as Error).message}`)
  }
}

/**
 * Get stack with current template body loaded
 */
export async function getStackWithTemplate(account: string, stackNameOrId: string): Promise<Stack & { TemplateBody?: string }> {
  const stack = await getStack(account, stackNameOrId)
  const stackName = stack.StackName
  
  try {
    const templateBody = await getStackTemplate(account, stackName)
    return { ...stack, TemplateBody: templateBody }
  } catch (e) {
    console.warn(`Could not load template for stack ${stackName}:`, e)
    return stack
  }
}

/**
 * List all stacks in an account
 */
export async function listStacks(account: string, statusFilter?: string | string[]): Promise<Stack[]> {
  const stacksDir = await getStacksDir(account)
  
  try {
    const stackDirs = await fs.readdir(stacksDir)
    
    const stacks: Stack[] = []
    for (const stackDir of stackDirs) {
      const stackPath = path.join(stacksDir, stackDir, 'stack.json')
      try {
        const data = await fs.readFile(stackPath, 'utf-8')
        const stack = JSON.parse(data) as Stack
        
        // Apply status filter if provided
        if (statusFilter) {
          const statuses = Array.isArray(statusFilter) ? statusFilter : [statusFilter]
          if (statuses.includes(stack.StackStatus)) {
            stacks.push(stack)
          }
        } else {
          stacks.push(stack)
        }
      } catch (e) {
        console.warn(`Failed to read stack from ${stackPath}:`, e)
        // Skip stacks that fail to read
      }
    }
    
    return stacks
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw new Error(`Failed to list stacks: ${(e as Error).message}`)
  }
}

/**
 * Update stack status
 */
export async function updateStackStatus(
  account: string,
  stackName: string,
  status: Stack['StackStatus'],
  statusReason?: string
): Promise<void> {
  const stack = await getStack(account, stackName)
  
  stack.StackStatus = status
  if (statusReason) {
    stack.StackStatusReason = statusReason
  }
  stack.LastUpdatedTime = Date.now()

  const stackFilePath = getStackFilePath(account, stackName)
  
  try {
    await fs.writeFile(stackFilePath, JSON.stringify(stack, null, 2), 'utf-8')
  } catch (e) {
    throw new Error(`Failed to update stack status: ${(e as Error).message}`)
  }
}

/**
 * Add a resource to a stack
 */
export async function addStackResource(
  account: string,
  stackName: string,
  resource: StackResource
): Promise<void> {
  const stack = await getStack(account, stackName)
  
  // Check if resource already exists
  const existingIndex = stack.Resources.findIndex(r => r.LogicalResourceId === resource.LogicalResourceId)
  if (existingIndex >= 0) {
    stack.Resources[existingIndex] = resource
  } else {
    stack.Resources.push(resource)
  }
  stack.LastUpdatedTime = Date.now()

  const stacksDir = await getStacksDir(account)
  const stackFilePath = path.join(stacksDir, `${stackName}.json`)
  
  try {
    await fs.writeFile(stackFilePath, JSON.stringify(stack, null, 2), 'utf-8')
  } catch (e) {
    throw new Error(`Failed to add resource: ${(e as Error).message}`)
  }
}

/**
 * Get all resources in a stack
 */
export async function getStackResources(account: string, stackName: string): Promise<StackResource[]> {
  const stack = await getStack(account, stackName)
  return stack.Resources || []
}

/**
 * Get template for a stack
 */
export async function getTemplate(account: string, stackName: string): Promise<string> {
  return await getStackTemplate(account, stackName)
}

/**
 * Delete a stack and all its template versions
 */
export async function deleteStack(account: string, stackName: string): Promise<void> {
  const stackDir = await getStackDir(account, stackName)
  
  try {
    // Recursively delete the entire stack directory
    await fs.rm(stackDir, { recursive: true, force: true })
    console.log(`Stack deleted: ${stackDir}`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Stack not found: ${stackName}`)
    }
    throw new Error(`Failed to delete stack: ${(e as Error).message}`)
  }
}

/**
 * Add an output to a stack
 */
export async function addStackOutput(
  account: string,
  stackName: string,
  outputKey: string,
  outputValue: string,
  description?: string,
  exportName?: string
): Promise<void> {
  const stack = await getStack(account, stackName)
  
  if (!stack.Outputs) {
    stack.Outputs = []
  }

  const existingIndex = stack.Outputs.findIndex(o => o.OutputKey === outputKey)
  const output = {
    OutputKey: outputKey,
    OutputValue: outputValue,
    Description: description,
    ExportName: exportName
  }

  if (existingIndex >= 0) {
    stack.Outputs[existingIndex] = output
  } else {
    stack.Outputs.push(output)
  }
  stack.LastUpdatedTime = Date.now()

  const stacksDir = await getStacksDir(account)
  const stackFilePath = path.join(stacksDir, `${stackName}.json`)
  
  try {
    await fs.writeFile(stackFilePath, JSON.stringify(stack, null, 2), 'utf-8')
  } catch (e) {
    throw new Error(`Failed to add output: ${(e as Error).message}`)
  }
}

/**
 * Look up an exported value by name
 */
export async function lookupExport(account: string, exportName: string): Promise<string | null> {
  const stacks = await listStacks(account)
  
  for (const stack of stacks) {
    if (stack.Outputs) {
      for (const output of stack.Outputs) {
        if (output.ExportName === exportName) {
          return output.OutputValue
        }
      }
    }
  }
  
  return null
}
