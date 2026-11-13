import { AwsError } from '../common'
import { JsonProtocol } from '../protocols'
import { defineService, type RequestContext } from '../registry'
import {
  createStack,
  getStack,
  listStacks,
  getTemplate,
  deleteStack,
  storeTemplate,
  updateStackStatus,
  getStackResources,
  type Stack,
} from './storage'

const protocol = new JsonProtocol()

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
            'ValidationException',
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
          throw new AwsError('ValidationException', msg)
        }
      }
    },

    CreateStack: {
      async handler(ctx: RequestContext) {
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
        } = ctx.params

        if (typeof StackName !== 'string' || !StackName.trim()) {
          throw new AwsError(
            'ValidationException',
            'StackName is required'
          )
        }

        if (typeof TemplateBody !== 'string' || !TemplateBody.trim()) {
          throw new AwsError(
            'ValidationException',
            'TemplateBody is required'
          )
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
            StackName,
            TemplateBody,
            Parameters,
            Tags,
            {
              description: Description,
              timeoutInMinutes: TimeoutInMinutes,
              notificationARNs: NotificationARNs,
              disableRollback: DisableRollback,
              capabilities: Capabilities,
              roleARN: RoleARN,
            }
          )

          return { StackId: stackId }
        } catch (error) {
          if (error instanceof AwsError) throw error
          const msg = error instanceof Error ? error.message : 'Failed to create stack'
          throw new AwsError('ValidationException', msg)
        }
      }
    },

    DescribeStacks: {
      async handler(ctx: RequestContext) {
        const { StackName } = ctx.params

        try {
          let stacks: Stack[] = []

          if (StackName) {
            // Single stack lookup
            const stack = await getStack(ctx.account, StackName)
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
          throw new AwsError('ValidationException', msg)
        }
      }
    },

    ListStacks: {
      async handler(ctx: RequestContext) {
        const { StackStatusFilter } = ctx.params

        try {
          const stacks = await listStacks(ctx.account, StackStatusFilter)

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
          throw new AwsError('ValidationException', msg)
        }
      }
    },

    GetTemplate: {
      async handler(ctx: RequestContext) {
        const { StackName } = ctx.params

        if (!StackName) {
          throw new AwsError(
            'ValidationException',
            'StackName is required'
          )
        }

        try {
          const templateBody = await getTemplate(ctx.account, StackName)
          const parsed = JSON.parse(templateBody)

          return {
            TemplateBody: templateBody,
            StagesAvailable: ['Original'],
            TemplateDescription: parsed.TemplateDescription,
          }
        } catch (error) {
          if (error instanceof AwsError) throw error
          const msg = error instanceof Error ? error.message : 'Template not found'
          throw new AwsError('ValidationException', msg)
        }
      }
    },

    DeleteStack: {
      async handler(ctx: RequestContext) {
        const { StackName } = ctx.params

        if (!StackName) {
          throw new AwsError(
            'ValidationException',
            'StackName is required'
          )
        }

        try {
          const stack = await getStack(ctx.account, StackName)

          if (stack.EnableTerminationProtection) {
            throw new AwsError(
              'ValidationException',
              `Stack [${StackName}] cannot be deleted while TerminationProtection is enabled`
            )
          }

          await updateStackStatus(ctx.account, StackName, 'DELETE_IN_PROGRESS')
          await deleteStack(ctx.account, StackName)
          await updateStackStatus(ctx.account, StackName, 'DELETE_COMPLETE')

          return { StackId: stack.StackId }
        } catch (error) {
          if (error instanceof AwsError) throw error
          const msg = error instanceof Error ? error.message : 'Failed to delete stack'
          throw new AwsError('ValidationException', msg)
        }
      }
    },

    ExecuteChangeSet: {
      async handler(ctx: RequestContext) {
        const { ChangeSetName, StackName } = ctx.params

        if (!StackName) {
          throw new AwsError(
            'ValidationException',
            'StackName is required'
          )
        }

        if (!ChangeSetName) {
          throw new AwsError(
            'ValidationException',
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
          throw new AwsError('ValidationException', msg)
        }
      }
    },

    DescribeStackResources: {
      async handler(ctx: RequestContext) {
        const { StackName, LogicalResourceId, PhysicalResourceId } = ctx.params

        if (!StackName) {
          throw new AwsError(
            'ValidationException',
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
          throw new AwsError('ValidationException', msg)
        }
      }
    }
  }
})

export default cloudFormation

