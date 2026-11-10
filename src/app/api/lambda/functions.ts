import { createHash, randomUUID } from "crypto"
import { AwsError } from "../common"
import { loadState } from "../db/ec2/state"
import * as iam from "../db/iam"
import { functionArn, loadLambda, notFound, parseReference, saveLambda, type FunctionRecord } from "../db/lambda"
import { QUOTAS, hardLimit } from "../quotas"
import type { RequestContext } from "../registry"
import { reconcileInterfaces } from "./network"
import { removeCode, unpack, writeCode } from "./code"
import { invalidParameter, validation } from "./errors"

// The control plane of Lambda, as far as the walking skeleton needs it (docs/walking-skeleton.md): inline Python functions,
// optionally in a VPC. What is not supported is rejected by name. Behaviour written from the API reference and from
// memory of AWS is listed in lambda.md under "Not verified".

// The Python runtimes. The code runs on the python3 of the machine whatever the version; the name only shows up in the
// environment (AWS_EXECUTION_ENV).
export const RUNTIMES = ['python3.9', 'python3.10', 'python3.11', 'python3.12', 'python3.13']

const RESERVED_ENVIRONMENT = new Set([
  '_HANDLER', '_X_AMZN_TRACE_ID', 'AWS_DEFAULT_REGION', 'AWS_REGION', 'AWS_EXECUTION_ENV', 'AWS_LAMBDA_FUNCTION_NAME',
  'AWS_LAMBDA_FUNCTION_MEMORY_SIZE', 'AWS_LAMBDA_FUNCTION_VERSION', 'AWS_LAMBDA_INITIALIZATION_TYPE', 'AWS_LAMBDA_LOG_GROUP_NAME',
  'AWS_LAMBDA_LOG_STREAM_NAME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_LAMBDA_RUNTIME_API',
  'LAMBDA_TASK_ROOT', 'LAMBDA_RUNTIME_DIR',
])

// Parameters of CreateFunction that are not modelled; sending them with a value is refused.
const UNSUPPORTED = ['DeadLetterConfig', 'KMSKeyArn', 'Layers', 'FileSystemConfigs', 'ImageConfig', 'CodeSigningConfigArn', 'SnapStart', 'LoggingConfig']

const ROLE = /^arn:(aws[a-zA-Z-]*)?:iam::(\d{12}):role\/?([a-zA-Z_0-9+=,.@\-_/]+)$/
const NAME = /^[a-zA-Z0-9-_]+$/

const present = (value: unknown) => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)
const timestamp = () => new Date().toISOString().replace('Z', '+0000')

function resolveVpc(ctx: RequestContext, vpc: any): Record<string, any> | undefined {
  const subnetIds: string[] = [...new Set<string>(vpc?.SubnetIds ?? [])]
  let groupIds: string[] = [...new Set<string>(vpc?.SecurityGroupIds ?? [])]
  if (!subnetIds.length) {
    if (groupIds.length) {
      throw invalidParameter('SecurityGroupIds were given without SubnetIds; a function is attached to a VPC by its subnets')
    }
    return undefined
  }
  if (subnetIds.length > 16) {
    throw validation(`1 validation error detected: Value '[${subnetIds.join(', ')}]' at 'vpcConfig.subnetIds' failed to satisfy constraint: Member must have length less than or equal to 16`)
  }
  if (groupIds.length > 5) {
    throw validation(`1 validation error detected: Value '[${groupIds.join(', ')}]' at 'vpcConfig.securityGroupIds' failed to satisfy constraint: Member must have length less than or equal to 5`)
  }
  const state = loadState({ account: ctx.account, region: ctx.region })
  const subnets = subnetIds.map(id => {
    const subnet = state.subnets[id]
    if (!subnet) {
      throw invalidParameter(`Error occurred while DescribeSubnets. EC2 Error Code: InvalidSubnetID.NotFound. EC2 Error Message: The subnet ID '${id}' does not exist`)
    }
    return subnet
  })
  const vpcIds = [...new Set(subnets.map(s => s.VpcId as string))]
  if (vpcIds.length > 1) {
    throw invalidParameter(`Error occurred while DescribeSubnets. EC2 Error Code: InvalidParameterValue. EC2 Error Message: Subnets ${subnetIds.join(', ')} belong to different networks (${vpcIds.join(', ')}).`)
  }
  if (!groupIds.length) {
    const fallback = Object.values(state.securityGroups).find(g => g.VpcId === vpcIds[0] && g.GroupName === 'default')
    groupIds = [fallback!.GroupId]
  }
  for (const id of groupIds) {
    const group = state.securityGroups[id]
    if (!group) {
      throw invalidParameter(`Error occurred while DescribeSecurityGroups. EC2 Error Code: InvalidGroup.NotFound. EC2 Error Message: The security group '${id}' does not exist`)
    }
    if (group.VpcId !== vpcIds[0]) {
      throw invalidParameter(`Error occurred while DescribeSecurityGroups. EC2 Error Code: InvalidParameterValue. EC2 Error Message: Security group ${id} and subnet ${subnetIds[0]} belong to different networks.`)
    }
  }
  return { SubnetIds: subnetIds, SecurityGroupIds: groupIds, VpcId: vpcIds[0], Ipv6AllowedForDualStack: false }
}

function checkRange(value: number, name: string, min: number, max: number) {
  if (!Number.isInteger(value) || value < min) {
    throw validation(`1 validation error detected: Value '${value}' at '${name}' failed to satisfy constraint: Member must have value greater than or equal to ${min}`)
  }
  if (value > max) {
    throw validation(`1 validation error detected: Value '${value}' at '${name}' failed to satisfy constraint: Member must have value less than or equal to ${max}`)
  }
}

export function createFunction(ctx: RequestContext) {
  const { account, region, params: p } = ctx
  const scope = { account, region }
  for (const [field, member] of [['functionName', 'FunctionName'], ['role', 'Role'], ['code', 'Code']] as const) {
    if (!present(p[member])) {
      throw validation(`1 validation error detected: Value null at '${field}' failed to satisfy constraint: Member must not be null`)
    }
  }
  const name: string = p.FunctionName
  if (!NAME.test(name) || name.length > 64) {
    throw validation(`1 validation error detected: Value '${name}' at 'functionName' failed to satisfy constraint: Member must satisfy regular expression pattern: (arn:(aws[a-zA-Z-]*)?:lambda:)?([a-z]{2}(-gov)?-[a-z]+-\\d{1}:)?(\\d{12}:)?(function:)?([a-zA-Z0-9-_]+)(:(\\$LATEST|[a-zA-Z0-9-_]+))?`)
  }
  const role = ROLE.exec(p.Role)
  if (!role) {
    throw validation(`1 validation error detected: Value '${p.Role}' at 'role' failed to satisfy constraint: Member must satisfy regular expression pattern: arn:(aws[a-zA-Z-]*)?:iam::\\d{12}:role/?[a-zA-Z_0-9+=,.@\\-_/]+`)
  }

  for (const member of UNSUPPORTED) {
    if (present(p[member])) {
      throw invalidParameter(`Parameter '${member}' is not supported by this simulator yet`)
    }
  }
  if (present(p.PackageType) && p.PackageType !== 'Zip') {
    throw invalidParameter(`PackageType '${p.PackageType}' is not supported by this simulator yet (only Zip)`)
  }
  if (p.Publish) {
    throw invalidParameter(`Parameter 'Publish' is not supported by this simulator yet (no versions)`)
  }
  if (present(p.TracingConfig) && p.TracingConfig.Mode !== 'PassThrough') {
    throw invalidParameter(`Parameter 'TracingConfig' is not supported by this simulator yet`)
  }
  if (present(p.EphemeralStorage) && p.EphemeralStorage.Size !== 512) {
    throw invalidParameter(`Parameter 'EphemeralStorage' is not supported by this simulator yet (only 512 MB)`)
  }
  for (const member of Object.keys(p.Code)) {
    if (member !== 'ZipFile') {
      throw invalidParameter(`Code.${member} is not supported by this simulator yet (only ZipFile; there is no S3 or ECR)`)
    }
  }
  if (typeof p.Code.ZipFile !== 'string') {
    throw invalidParameter('Code.ZipFile is required')
  }

  if (!present(p.Runtime) || !present(p.Handler)) {
    throw invalidParameter('Runtime and Handler are required for a function packaged as a zip file')
  }
  if (!RUNTIMES.includes(p.Runtime)) {
    throw invalidParameter(`Runtime '${p.Runtime}' is not supported by this simulator yet (${RUNTIMES.join(', ')})`)
  }
  const timeout = p.Timeout ?? 3
  const memory = p.MemorySize ?? 128
  checkRange(timeout, 'timeout', 1, hardLimit(QUOTAS.lambdaTimeout))
  checkRange(memory, 'memorySize', hardLimit(QUOTAS.lambdaMemoryMin), hardLimit(QUOTAS.lambdaMemoryMax))

  const variables: Record<string, string> = p.Environment?.Variables ?? {}
  const reserved = Object.keys(variables).filter(key => RESERVED_ENVIRONMENT.has(key))
  if (reserved.length) {
    throw invalidParameter(`Lambda was unable to configure your environment variables because the environment variables you have provided contains reserved keys that are currently not supported for modification. Reserved keys used in this request: ${reserved.join(',')}`)
  }
  const environmentSize = Object.entries(variables).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(String(value)), 0)
  if (environmentSize > hardLimit(QUOTAS.lambdaEnvironmentSize)) {
    throw invalidParameter(`Lambda was unable to configure your environment variables because the environment variables you have provided exceeded the 4KB limit. String measured: ${Object.entries(variables).map(([k, v]) => `${k}=${v}`).join(',')}`)
  }

  const zip = Buffer.from(p.Code.ZipFile, 'base64')
  if (zip.length > hardLimit(QUOTAS.lambdaPackageDirectSize)) {
    throw new AwsError('RequestEntityTooLargeException', `Zipped file size must be smaller than ${hardLimit(QUOTAS.lambdaPackageDirectSize)} bytes when uploaded through the API; upload larger packages through S3`, 413)
  }
  const files = unpack(zip)
  const iamRole = iam.findRole(role[2], role[3].split('/').at(-1)!)
  if (!iamRole || iamRole.arn !== p.Role || !iam.trustsService(iamRole, 'lambda.amazonaws.com')) {
    throw invalidParameter('The role defined for the function cannot be assumed by Lambda.')
  }

  const lambda = loadLambda(scope)
  if (lambda.functions[name]) {
    throw new AwsError('ResourceConflictException', `Function already exist: ${name}`, 409)
  }
  const vpc = resolveVpc(ctx, p.VpcConfig)

  const configuration: Record<string, any> = {
    FunctionName: name,
    FunctionArn: functionArn(scope, name),
    Runtime: p.Runtime,
    Role: p.Role,
    Handler: p.Handler,
    CodeSize: zip.length,
    Description: p.Description ?? '',
    Timeout: timeout,
    MemorySize: memory,
    LastModified: timestamp(),
    CodeSha256: createHash('sha256').update(zip).digest('base64'),
    Version: '$LATEST',
    ...(vpc ? { VpcConfig: vpc } : {}),
    ...(present(p.Environment) ? { Environment: { Variables: variables } } : {}),
    TracingConfig: { Mode: 'PassThrough' },
    RevisionId: randomUUID(),
    State: 'Active',
    LastUpdateStatus: 'Successful',
    PackageType: 'Zip',
    Architectures: present(p.Architectures) ? p.Architectures : ['x86_64'],
    EphemeralStorage: { Size: 512 },
    SnapStart: { ApplyOn: 'None', OptimizationStatus: 'Off' },
    LoggingConfig: { LogFormat: 'Text', LogGroup: `/aws/lambda/${name}` },
  }
  const record: FunctionRecord = { Configuration: configuration, Tags: p.Tags ?? {} }
  lambda.functions[name] = record

  // Creating the shared interface can fail (a full subnet, the interface quota): the function is then created in the
  // Failed state, as AWS does, and says why.
  const failure = reconcileInterfaces(scope, lambda).find(f => f.functionName === name)
  if (failure) {
    Object.assign(configuration, { State: 'Failed', StateReason: failure.message, StateReasonCode: failure.code, LastUpdateStatus: 'Failed' })
  }
  writeCode(scope, name, files)
  saveLambda(scope, lambda)
  return configuration
}

// Replaces the code of a function. The files of the old code are removed; the code size and hash are those of the new
// upload. Only $LATEST exists, so there is no Publish.
export function updateFunctionCode(ctx: RequestContext) {
  const { params: p } = ctx
  const { name, record } = lookup(ctx, p.FunctionName)
  const scope = { account: ctx.account, region: ctx.region }
  for (const member of ['S3Bucket', 'S3Key', 'S3ObjectVersion', 'ImageUri', 'SourceKMSKeyArn']) {
    if (present(p[member])) {
      throw invalidParameter(`${member} is not supported by this simulator yet (only ZipFile; there is no S3 or ECR)`)
    }
  }
  if (p.Publish) {
    throw invalidParameter(`Parameter 'Publish' is not supported by this simulator yet (no versions)`)
  }
  if (present(p.Architectures)) {
    throw invalidParameter(`Parameter 'Architectures' is not supported by this simulator yet when updating code`)
  }
  if (typeof p.ZipFile !== 'string') {
    throw invalidParameter('ZipFile is required')
  }
  const zip = Buffer.from(p.ZipFile, 'base64')
  if (zip.length > hardLimit(QUOTAS.lambdaPackageDirectSize)) {
    throw new AwsError('RequestEntityTooLargeException', `Zipped file size must be smaller than ${hardLimit(QUOTAS.lambdaPackageDirectSize)} bytes when uploaded through the API; upload larger packages through S3`, 413)
  }
  const files = unpack(zip)
  if (!p.DryRun) {
    writeCode(scope, name, files)
    Object.assign(record.Configuration, {
      CodeSize: zip.length,
      CodeSha256: createHash('sha256').update(zip).digest('base64'),
      LastModified: timestamp(),
      RevisionId: randomUUID(),
    })
    const lambda = loadLambda(scope)
    lambda.functions[name] = record
    saveLambda(scope, lambda)
  }
  return record.Configuration
}

// Finds the function a request names (name, partial or full ARN, qualifier). Only $LATEST exists.
export function lookup(ctx: RequestContext, reference: unknown, qualifier?: string): { name: string; record: FunctionRecord } {
  if (typeof reference !== 'string' || reference === '') {
    throw validation(`1 validation error detected: Value null at 'functionName' failed to satisfy constraint: Member must not be null`)
  }
  const ref = parseReference(reference)
  const scope = { account: ctx.account, region: ctx.region }
  if (ref.region && ref.region !== ctx.region) {
    throw invalidParameter(`Functions from '${ref.region}' are not reachable in this region ('${ctx.region}')`)
  }
  const record = ref.account && ref.account !== ctx.account ? undefined : loadLambda(scope).functions[ref.name]
  const requested = qualifier ?? ref.qualifier
  if (!record) {
    throw notFound(scope, ref.name)
  }
  if (requested !== undefined && requested !== '$LATEST') {
    throw new AwsError('ResourceNotFoundException', `Function not found: ${functionArn(scope, ref.name)}:${requested}`, 404)
  }
  return { name: ref.name, record }
}

export function getFunction(ctx: RequestContext) {
  const { name, record } = lookup(ctx, ctx.params.FunctionName, ctx.params.Qualifier)
  return {
    Configuration: record.Configuration,
    // There is no S3 to serve the package from; the location is a stand-in.
    Code: { RepositoryType: 'S3', Location: `https://awslambda-${ctx.region}-tasks.s3.${ctx.region}.amazonaws.com/snapshots/${ctx.account}/${name}` },
    ...(Object.keys(record.Tags).length ? { Tags: record.Tags } : {}),
  }
}

export const getFunctionConfiguration = (ctx: RequestContext) => lookup(ctx, ctx.params.FunctionName, ctx.params.Qualifier).record.Configuration

// Without versions the only version of a function is $LATEST. The following reads exist because Terraform and the
// console ask for them after every create; they answer for a function that has no signing config, recursion setting or
// reserved concurrency, which is all there is.
export const listVersionsByFunction = (ctx: RequestContext) => ({ Versions: [lookup(ctx, ctx.params.FunctionName).record.Configuration] })

export const getFunctionCodeSigningConfig = (ctx: RequestContext) => ({ FunctionName: lookup(ctx, ctx.params.FunctionName).name })

export const getFunctionRecursionConfig = (ctx: RequestContext) => {
  lookup(ctx, ctx.params.FunctionName)
  return { RecursiveLoop: 'Terminate' }
}

export const getFunctionConcurrency = (ctx: RequestContext) => {
  lookup(ctx, ctx.params.FunctionName)
  return {}
}

export const listTags = (ctx: RequestContext) => ({ Tags: lookup(ctx, ctx.params.Resource).record.Tags })

export function listFunctions(ctx: RequestContext) {
  const { Marker, MaxItems, FunctionVersion } = ctx.params
  if (FunctionVersion !== undefined) {
    throw invalidParameter(`Parameter 'FunctionVersion' is not supported by this simulator yet`)
  }
  const limit = MaxItems === undefined ? 50 : Number(MaxItems)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw validation(`1 validation error detected: Value '${MaxItems}' at 'maxItems' failed to satisfy constraint: Member must have value between 1 and 50`)
  }
  const functions = loadLambda({ account: ctx.account, region: ctx.region }).functions
  const names = Object.keys(functions).sort()
  const start = Marker === undefined ? 0 : names.findIndex(n => n > Marker)
  const page = start < 0 ? [] : names.slice(start, start + limit)
  return {
    Functions: page.map(n => functions[n].Configuration),
    ...(start >= 0 && start + limit < names.length ? { NextMarker: page.at(-1) } : {}),
  }
}

export function deleteFunction(ctx: RequestContext) {
  const { name } = lookup(ctx, ctx.params.FunctionName, ctx.params.Qualifier)
  const scope = { account: ctx.account, region: ctx.region }
  const lambda = loadLambda(scope)
  delete lambda.functions[name]
  delete lambda.invocations?.[name]
  removeCode(scope, name)
  // the shared interface goes with the last function that used it
  reconcileInterfaces(scope, lambda)
  saveLambda(scope, lambda)
  return undefined
}
