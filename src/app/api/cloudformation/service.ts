import { AwsError } from '../common'
import { defineService, type RequestContext } from '../registry'
import { CloudFormationQueryProtocol, toBoolean, toInteger } from './query-protocol'
import { checkPassRole } from './role'
import {
  createStack,
  getStack,
  listStacks,
  getTemplate,
  deleteStack,
  storeTemplate,
  updateStackStatus,
  getStackResources,
  stripInternalFields,
  type Stack,
} from './storage'

const protocol = new CloudFormationQueryProtocol()

// An empty list arrives as `Name=` (a string) in the query protocol.
function asList<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? value as T[] : undefined
}

// The ARN policies match a stack operation against; a StackName may also be the stack ID (the full ARN).
function stackResource({ account, region, params }: RequestContext): string[] {
  const name = params.StackName
  if (typeof name !== 'string' || !name) return ['*']
  return [name.startsWith('arn:') ? name : `arn:aws:cloudformation:${region}:${account}:stack/${name}/*`]
}

/**
 * CloudFormation service - Infrastructure as Code stack management
 * 
 * Scope (Phase 1):
 * - ValidateTemplate: Validate template syntax and resources
 * - CreateStack: Create new stack from template
 * - DescribeStacks: Get stack details
 * - ListStacks: List all stacks
 * - GetTemplate: Retrieve original template
 * - DeleteStack: Delete stack and resources
 * - ExecuteChangeSet: Deploy stack changes (MVP)
 * - DescribeStackResources: Get resources created by stack
 * 
 * Resource support progression:
 * 1. SSM::Parameter (simple key-value)
 * 2. Lambda::Function (with inline code)
 * 3. Full network (VPC, Subnets, SecurityGroups, NetworkInterfaces)
 */
export const cloudFormation = defineService({
  iamPrefix: 'cloudformation',
  protocol,

  operations: {
    ValidateTemplate: {
      async handler(ctx: RequestContext) {
        const { TemplateBody } = ctx.params

        if (typeof TemplateBody !== 'string' || !TemplateBody.trim()) {
          throw new AwsError(
            'ValidationError',
            'Template body cannot be empty'
          )
        }

        try {
          const template = await storeTemplate(ctx.account, TemplateBody)
          return {
            Description: template.TemplateDescription,
            Parameters: Object.entries(template.Parameters || {}).map(([name, param]) => ({
              ParameterKey: name,
              ParameterType: param.Type || 'String',
              DefaultValue: param.Default,
              Description: param.Description,
            })),
            Capabilities: [],
            CapabilitiesReason: 'This template requires no special capabilities.',
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Invalid template'
          throw new AwsError('ValidationError', msg)
        }
      }
    },

    CreateStack: {
      resources: stackResource,
      async handler(ctx: RequestContext) {
        console.log('[CloudFormation:CreateStack] Starting, ctx.account:', ctx.account, 'ctx.region:', ctx.region)
        const {
          StackName,
          TemplateBody,
          Parameters,
          Tags,
          TimeoutInMinutes,
          NotificationARNs,
          DisableRollback,
          Capabilities,
          RoleARN,
          Description,
          EnableTerminationProtection,
        } = ctx.params

        if (typeof StackName !== 'string' || !StackName.trim()) {
          throw new AwsError(
            'ValidationError',
            'StackName is required'
          )
        }

        if (typeof TemplateBody !== 'string' || !TemplateBody.trim()) {
          throw new AwsError(
            'ValidationError',
            'TemplateBody is required'
          )
        }

        if (RoleARN !== undefined) {
          checkPassRole(ctx, RoleARN)
        }

        try {
          // Validate template first
          await storeTemplate(ctx.account, TemplateBody)

          // Check if stack already exists
          try {
            await getStack(ctx.account, StackName)
            throw new AwsError(
              'AlreadyExistsException',
              `Stack with name ${StackName} already exists`
            )
          } catch (e) {
            if (e instanceof AwsError && e.type === 'AlreadyExistsException') throw e
            // Stack doesn't exist, continue
          }

          const stackId = await createStack(
            ctx.account,
            ctx.region,
            StackName,
            TemplateBody,
            Description,
            asList(Parameters),
            asList(Tags),
            toInteger(TimeoutInMinutes),
            asList(NotificationARNs),
            toBoolean(DisableRollback),
            asList(Capabilities),
            RoleARN,
            toBoolean(EnableTerminationProtection),
            { principal: ctx.principal, account: ctx.account, region: ctx.region }
          )

          return { StackId: stackId }
        } catch (error) {
          if (error instanceof AwsError) throw error
          const errMsg = (error instanceof Error ? error.message : String(error)) || 'Failed to create stack'
          console.error('[CF CreateStack] Error:', errMsg, 'Full error:', error)
          throw new AwsError('ValidationError', errMsg)
        }
      }
    },

    DescribeStacks: {
      resources: stackResource,
      async handler(ctx: RequestContext) {
        const { StackName } = ctx.params

        try {
          let stacks: Stack[] = []

          if (StackName) {
            // Single stack lookup
            const stack = await getStack(ctx.account, StackName).catch(() => {
              throw new AwsError('ValidationError', `Stack with id ${StackName} does not exist`)
            })
            stacks = [stack]
          } else {
            // List all stacks
            stacks = await listStacks(ctx.account)
          }

          return {
            Stacks: stacks.map(s => ({
              StackId: s.StackId,
              StackName: s.StackName,
              Description: s.Description,
              Parameters: s.Parameters,
              CreationTime: new Date(s.CreationTime).toISOString(),
              LastUpdatedTime: s.LastUpdatedTime ? new Date(s.LastUpdatedTime).toISOString() : undefined,
              StackStatus: s.StackStatus,
              StackStatusReason: s.StackStatusReason,
              DisableRollback: s.DisableRollback,
              NotificationARNs: s.NotificationARNs,
              TimeoutInMinutes: s.TimeoutInMinutes,
              Capabilities: s.Capabilities,
              Tags: s.Tags,
              RoleARN: s.RoleARN,
              EnableTerminationProtection: s.EnableTerminationProtection,
              Outputs: s.Outputs,
            }))
          }
        } catch (error) {
          if (error instanceof AwsError) throw error
          const msg = error instanceof Error ? error.message : 'Stack not found'
          throw new AwsError('ValidationError', msg)
        }
      }
    },

    ListStacks: {
      async handler(ctx: RequestContext) {
        const { StackStatusFilter } = ctx.params

        try {
          const stacks = await listStacks(ctx.account, asList<string>(StackStatusFilter))

          return {
            StackSummaries: stacks.map(s => ({
              StackId: s.StackId,
              StackName: s.StackName,
              StackStatus: s.StackStatus,
              StackStatusReason: s.StackStatusReason,
              CreationTime: new Date(s.CreationTime).toISOString(),
              LastUpdatedTime: s.LastUpdatedTime ? new Date(s.LastUpdatedTime).toISOString() : undefined,
              TemplateDescription: s.Description,
              DriftInformation: {
                StackDriftStatus: 'UNKNOWN',
                LastCheckTimestamp: undefined,
              },
            }))
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to list stacks'
          throw new AwsError('ValidationError', msg)
        }
      }
    },

    GetTemplate: {
      resources: stackResource,
      async handler(ctx: RequestContext) {
        const { StackName } = ctx.params

        if (!StackName) {
          throw new AwsError(
            'ValidationError',
            'StackName is required'
          )
        }

        try {
          const templateBody = await getTemplate(ctx.account, StackName, { principal: ctx.principal, account: ctx.account, region: ctx.region })
          const parsed = JSON.parse(templateBody)

          return {
            TemplateBody: templateBody,
            StagesAvailable: ['Original'],
            TemplateDescription: parsed.TemplateDescription,
          }
        } catch (error) {
          if (error instanceof AwsError) throw error
          const msg = error instanceof Error ? error.message : 'Template not found'
          throw new AwsError('ValidationError', msg)
        }
      }
    },

    DeleteStack: {
      resources: stackResource,
      async handler(ctx: RequestContext) {
        const { StackName, RoleARN } = ctx.params

        if (!StackName) {
          throw new AwsError(
            'ValidationError',
            'StackName is required'
          )
        }

        if (RoleARN !== undefined) {
          checkPassRole(ctx, RoleARN)
        }

        try {
          const stack = await getStack(ctx.account, StackName)

          if (stack.EnableTerminationProtection) {
            throw new AwsError(
              'ValidationError',
              `Stack [${StackName}] cannot be deleted while TerminationProtection is enabled`
            )
          }

          await updateStackStatus(ctx.account, StackName, 'DELETE_IN_PROGRESS')
          await deleteStack(ctx.account, StackName)

          return { StackId: stack.StackId }
        } catch (error) {
          if (error instanceof AwsError) throw error
          const msg = error instanceof Error ? error.message : 'Failed to delete stack'
          throw new AwsError('ValidationError', msg)
        }
      }
    },

    ExecuteChangeSet: {
      resources: stackResource,
      async handler(ctx: RequestContext) {
        const { ChangeSetName, StackName } = ctx.params

        if (!StackName) {
          throw new AwsError(
            'ValidationError',
            'StackName is required'
          )
        }

        if (!ChangeSetName) {
          throw new AwsError(
            'ValidationError',
            'ChangeSetName is required'
          )
        }

        try {
          const stack = await getStack(ctx.account, StackName)

          // For MVP: treat ExecuteChangeSet as stack update/deploy
          // In real CFN, changesets are planned before execution
          // For now, we'll just mark stack as deployed
          await updateStackStatus(
            ctx.account,
            StackName,
            stack.StackStatus === 'CREATE_IN_PROGRESS' ? 'CREATE_COMPLETE' : 'UPDATE_COMPLETE'
          )

          return { StackId: stack.StackId }
        } catch (error) {
          if (error instanceof AwsError) throw error
          const msg = error instanceof Error ? error.message : 'Failed to execute changeset'
          throw new AwsError('ValidationError', msg)
        }
      }
    },

    DescribeStackResources: {
      resources: stackResource,
      async handler(ctx: RequestContext) {
        const { StackName, LogicalResourceId, PhysicalResourceId } = ctx.params

        if (!StackName) {
          throw new AwsError(
            'ValidationError',
            'StackName is required'
          )
        }

        try {
          const resources = await getStackResources(ctx.account, StackName)
          const stack = await getStack(ctx.account, StackName)

          let filtered = resources
          if (LogicalResourceId) {
            filtered = filtered.filter(r => r.LogicalResourceId === LogicalResourceId)
          }
          if (PhysicalResourceId) {
            filtered = filtered.filter(r => r.PhysicalResourceId === PhysicalResourceId)
          }

          return {
            StackResources: filtered.map(r => ({
              LogicalResourceId: r.LogicalResourceId,
              PhysicalResourceId: r.PhysicalResourceId,
              ResourceType: r.ResourceType,
              Timestamp: new Date(r.Timestamp).toISOString(),
              ResourceStatus: r.ResourceStatus,
              StatusReason: r.StatusReason,
              StackId: stack.StackId,
              StackName: StackName,
            }))
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Stack not found'
          throw new AwsError('ValidationError', msg)
        }
      }
    }
  }
})

export default cloudFormation

