import { AwsError } from "../common"
import { newId } from "../db/ec2/ids"
import { describe } from "./describe"
import { KINDS, find, invalidValue, missing, tagsFromSpecifications, type Op } from "./request"

export interface VpcEndpoint {
  VpcEndpointId: string
  ServiceName: string
  VpcId: string
  State: 'pending' | 'available' | 'deleting' | 'deleted'
  SubnetIds: string[]
  SecurityGroupIds: string[]
  VpcEndpointType: 'Gateway' | 'Interface'
  CreationTimestamp: string
  Tags: Array<{ Key: string; Value: string }>
  PrivateDnsName?: string
  PrivateDnsNameConfiguration?: {
    PrivateDnsName?: string
    PrivateDnsNameState?: string
  }
  PrivateDnsEnabled?: boolean
  // Resource-based policy controlling who can use this endpoint (optional, defaults to allow all)
  PolicyDocument?: Record<string, any>
}

export const SUPPORTED_SERVICES = [
  'com.amazonaws.{region}.logs',
  'com.amazonaws.{region}.s3',
  'com.amazonaws.{region}.dynamodb',
]

export function isValidServiceName(serviceName: string, region: string): boolean {
  const patterns = [
    /^com\.amazonaws\.[a-z0-9-]+\.logs$/,
    /^com\.amazonaws\.[a-z0-9-]+\.s3$/,
    /^com\.amazonaws\.[a-z0-9-]+\.dynamodb$/,
  ]
  return patterns.some(p => p.test(serviceName))
}

export function extractServiceFromName(serviceName: string): 'logs' | 's3' | 'dynamodb' {
  const match = serviceName.match(/\.([a-z]+)$/)
  if (!match) throw new Error(`Invalid service name: ${serviceName}`)
  return match[1] as 'logs' | 's3' | 'dynamodb'
}

export const createVpcEndpointOp: Op = (state, { scope, params }) => {
  if (!params.VpcId) {
    missing('VpcId')
  }
  if (!params.ServiceName) {
    missing('ServiceName')
  }
  
  const { account, region } = scope
  if (!isValidServiceName(params.ServiceName, region)) {
    invalidValue(
      `Invalid ServiceName: ${params.ServiceName}. Must be one of: ${SUPPORTED_SERVICES.map(s => s.replace('{region}', region)).join(', ')}`
    )
  }

  const vpc = find(state.vpcs, params.VpcId, KINDS.vpc)

  // Validate subnets if provided (for Interface endpoints)
  if (params.SubnetIds && params.SubnetIds.length > 0) {
    for (const subnetId of params.SubnetIds) {
      const subnet = find(state.subnets, subnetId, KINDS.subnet)
      if (subnet.VpcId !== vpc.VpcId) {
        throw new AwsError(
          'InvalidParameterValue',
          `Subnet ${subnetId} is not in VPC ${vpc.VpcId}`
        )
      }
    }
  }

  // Validate security groups if provided
  if (params.SecurityGroupIds && params.SecurityGroupIds.length > 0) {
    for (const sgId of params.SecurityGroupIds) {
      const sg = find(state.securityGroups, sgId, KINDS.securityGroup)
      if (sg.VpcId !== vpc.VpcId) {
        throw new AwsError(
          'InvalidParameterValue',
          `Security group ${sgId} is not in VPC ${vpc.VpcId}`
        )
      }
    }
  }

  const vpcEndpointId = newId('vpce')
  const tags = tagsFromSpecifications(params.TagSpecifications, 'vpc-endpoint')
  
  // Parse policy document if provided
  let policyDocument: Record<string, any> | undefined
  if (params.PolicyDocument) {
    try {
      policyDocument = typeof params.PolicyDocument === 'string' 
        ? JSON.parse(params.PolicyDocument) 
        : params.PolicyDocument
    } catch (e) {
      invalidValue('Invalid PolicyDocument: must be valid JSON')
    }
  }

  const vpcEndpoint: VpcEndpoint = {
    VpcEndpointId: vpcEndpointId,
    ServiceName: params.ServiceName,
    VpcId: vpc.VpcId,
    State: 'available',
    SubnetIds: params.SubnetIds || [],
    SecurityGroupIds: params.SecurityGroupIds || [],
    VpcEndpointType: params.VpcEndpointType || 'Interface',
    CreationTimestamp: new Date().toISOString(),
    Tags: tags,
    PrivateDnsEnabled: params.PrivateDnsEnabled !== false,
    PolicyDocument: policyDocument,
  }

  if (!state.vpcEndpoints) {
    state.vpcEndpoints = {}
  }
  state.vpcEndpoints[vpcEndpointId] = vpcEndpoint

  return { VpcEndpoint: vpcEndpoint }
}

export const deleteVpcEndpointOp: Op = (state, { params }) => {
  if (!params.VpcEndpointIds || params.VpcEndpointIds.length === 0) {
    missing('VpcEndpointIds')
  }

  if (!state.vpcEndpoints) {
    state.vpcEndpoints = {}
  }

  const unsuccessful = []
  const successful = []

  for (const vpceId of params.VpcEndpointIds) {
    if (!state.vpcEndpoints[vpceId]) {
      unsuccessful.push({
        ResourceId: vpceId,
        Error: {
          Code: 'InvalidVpcEndpointId.NotFound',
          Message: `The Vpc Endpoint ID '${vpceId}' does not exist`,
        },
      })
    } else {
      state.vpcEndpoints[vpceId].State = 'deleted'
      delete state.vpcEndpoints[vpceId]
      successful.push({
        VpcEndpointId: vpceId,
        CurrentState: 'deleted',
      })
    }
  }

  return {
    Successful: successful,
    Unsuccessful: unsuccessful,
  }
}

export const describeVpcEndpointsOp: Op = (state, { params }) => {
  if (!state.vpcEndpoints) {
    state.vpcEndpoints = {}
  }

  const { items, nextToken } = describe({
    items: Object.values(state.vpcEndpoints),
    idOf: vpce => vpce.VpcEndpointId,
    ids: params.VpcEndpointIds,
    kind: KINDS.vpcEndpoint,
    filters: params.Filters,
    maxResults: params.MaxResults,
    nextToken: params.NextToken,
    filterFns: {
      'service-name': vpce => vpce.ServiceName,
      'vpc-id': vpce => vpce.VpcId,
      'vpc-endpoint-id': vpce => vpce.VpcEndpointId,
      'vpc-endpoint-type': vpce => vpce.VpcEndpointType,
      'tag-key': vpce => vpce.Tags.map(t => t.Key),
    },
  })

  return { VpcEndpoints: items, NextToken: nextToken }
}

export const modifyVpcEndpointOp: Op = (state, { params }) => {
  if (!params.VpcEndpointId) {
    missing('VpcEndpointId')
  }

  if (!state.vpcEndpoints) {
    state.vpcEndpoints = {}
  }

  const vpce = find(state.vpcEndpoints, params.VpcEndpointId, KINDS.vpcEndpoint)

  if (params.PrivateDnsEnabled !== undefined) {
    vpce.PrivateDnsEnabled = params.PrivateDnsEnabled
  }

  if (params.SubnetIds) {
    vpce.SubnetIds = params.SubnetIds
  }

  if (params.SecurityGroupIds) {
    vpce.SecurityGroupIds = params.SecurityGroupIds
  }

  // Handle policy document updates
  if (params.PolicyDocument !== undefined) {
    let policyDocument: Record<string, any> | undefined = undefined
    if (params.PolicyDocument) {
      try {
        policyDocument = typeof params.PolicyDocument === 'string' 
          ? JSON.parse(params.PolicyDocument) 
          : params.PolicyDocument
      } catch {
        invalidValue('Invalid PolicyDocument: must be valid JSON')
      }
    }
    vpce.PolicyDocument = policyDocument
  }

  return { Return: true }
}
