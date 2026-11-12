import { createInterface } from "../db/ec2/interfaces"
import { loadState, saveState, type Ec2State, type Resource } from "../db/ec2/state"
import { AwsError } from "../common"
import type { LambdaState } from "../db/lambda"

// The network interfaces of VPC-attached functions. They are shared: one interface per combination of subnet and set of
// security groups, used by every function with that combination (docs/lambda-plan.md, "Interfaces are shared between
// functions"). The interface of a combination exists exactly while a function wants it, so it is derived from the
// functions after every change instead of being counted.

export const LAMBDA_INTERFACE = 'lambda'

interface Scope {
  account: string
  region: string
}

export interface VpcSettings {
  subnetIds: string[]
  securityGroupIds: string[]
}

export const vpcSettings = (configuration: Record<string, any>): VpcSettings | undefined => {
  const vpc = configuration.VpcConfig
  return vpc?.SubnetIds?.length ? { subnetIds: vpc.SubnetIds, securityGroupIds: vpc.SecurityGroupIds } : undefined
}

const groupsKey = (ids: string[]) => [...ids].sort().join(',')

// The shared interface for a subnet and a set of security groups, when there is one.
export function sharedInterface(state: Ec2State, subnetId: string, securityGroupIds: string[]): Resource | undefined {
  return Object.values(state.networkInterfaces).find(eni =>
    eni.InterfaceType === LAMBDA_INTERFACE && eni.SubnetId === subnetId
    && groupsKey((eni.Groups ?? []).map((g: { GroupId: string }) => g.GroupId)) === groupsKey(securityGroupIds))
}

export interface InterfaceFailure {
  functionName: string
  code: 'SubnetOutOfIPAddresses' | 'EniLimitExceeded' | 'InternalError'
  message: string
}

// Creates the interfaces the functions need and deletes the ones nobody needs any more. A function whose interface cannot
// be created is reported (a full subnet, the interface quota) and does not keep the others from getting theirs.
// 
// SAFETY: An interface is deleted ONLY when NO remaining function needs that (subnet, securityGroupIds) combination.
// This is safe because:
// 1. If a function specifies SubnetIds but no SecurityGroupIds, Lambda defaults to the VPC's default security group
// 2. The default SG always exists, so the interface cannot disappear unexpectedly
// 3. The "wanted" set is rebuilt from scratch each call by scanning all active functions
// 4. Only interfaces NOT in the "wanted" set are deleted—if any function still needs a combo, the interface remains
export function reconcileInterfaces(scope: Scope, lambda: LambdaState): InterfaceFailure[] {
  const state = loadState(scope)
  const failures: InterfaceFailure[] = []
  const wanted = new Set<string>()
  const key = (subnetId: string, groups: string[]) => `${subnetId}|${groupsKey(groups)}`

  const functions = Object.entries(lambda.functions).filter(([, f]) => f.Configuration.State !== 'Failed')
  for (const [name, record] of functions) {
    const settings = vpcSettings(record.Configuration)
    for (const subnetId of settings?.subnetIds ?? []) {
      wanted.add(key(subnetId, settings!.securityGroupIds))
      if (sharedInterface(state, subnetId, settings!.securityGroupIds)) {
        continue
      }
      try {
        createInterface(state, scope, {
          subnetId,
          description: `AWS Lambda VPC ENI-${name}-${crypto.randomUUID()}`,
          interfaceType: LAMBDA_INTERFACE,
          requesterManaged: true,
          groups: settings!.securityGroupIds.map(id => ({ GroupId: id, GroupName: state.securityGroups[id]?.GroupName })),
        })
      } catch (error) {
        const type = error instanceof AwsError ? error.type : undefined
        failures.push({
          functionName: name,
          code: type === 'InsufficientFreeAddressesInSubnet' ? 'SubnetOutOfIPAddresses' : type === 'NetworkInterfaceLimitExceeded' ? 'EniLimitExceeded' : 'InternalError',
          message: `Error occurred while creating ENI(s) for function: ${error instanceof Error ? error.message : String(error)}`,
        })
        // the interface of this combination does not exist, so nothing else is wanted of it
        wanted.delete(key(subnetId, settings!.securityGroupIds))
      }
    }
  }
  for (const [id, eni] of Object.entries(state.networkInterfaces)) {
    if (eni.InterfaceType === LAMBDA_INTERFACE && !wanted.has(key(eni.SubnetId, (eni.Groups ?? []).map((g: { GroupId: string }) => g.GroupId)))) {
      delete state.networkInterfaces[id]
    }
  }
  saveState(scope, state)
  return failures
}
