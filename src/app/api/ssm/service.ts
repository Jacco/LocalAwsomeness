import { defineService, type RequestContext } from "../registry"
import { JsonProtocol } from "../protocols"
import { PARTITION } from '../data/common'
import { getParameter, getServiceSetting, putParameter, setServiceSetting } from '../data/ssm'

const parameterArn = ({ account, region, params }: RequestContext) =>
  [`arn:${PARTITION}:ssm:${region}:${account}:parameter/${String(params.Name).replace(/^\//, '')}`]

const serviceSettingArn = ({ account, region, params }: RequestContext) =>
  [`arn:${PARTITION}:ssm:${region}:${account}:servicesetting/${String(params.SettingId).replace(/^\//, '')}`]

export const ssm = defineService({
  iamPrefix: 'ssm',
  protocol: new JsonProtocol('1.1'),
  operations: {
    GetParameter: {
      // TODO WithDecryption
      handler: ({ account, region, params }) => ({ Parameter: getParameter(account, region, params.Name) }),
      resources: parameterArn
    },

    // Condition keys for the policy engine: ssm:Overwrite, ssm:Policies, aws:RequestTag/*, aws:TagKeys
    PutParameter: {
      handler: ({ account, region, params }) => putParameter(account, region, {
        name: params.Name,
        value: params.Value,
        dataType: params.DataType,
        tier: params.Tier
      }),
      resources: parameterArn
    },

    GetServiceSetting: {
      handler: ({ account, region, params }) => ({ ServiceSetting: getServiceSetting(account, region, params.SettingId) }),
      resources: serviceSettingArn
    },

    UpdateServiceSetting: {
      handler: ({ account, region, principal, params }) => {
        setServiceSetting(account, region, params.SettingId, params.SettingValue, principal)
        return {}
      },
      resources: serviceSettingArn
    },

    // Placeholder response; parameters are not listed from the store yet.
    DescribeParameters: () => ({
      Parameters: [
        {
          AllowedPattern: "string",
          ARN: "string",
          DataType: "string",
          Description: "string",
          KeyId: "string",
          LastModifiedUser: "string",
          Name: "string",
          Policies: [{ PolicyStatus: "string", PolicyText: "string", PolicyType: "string" }],
          Tier: "string",
          Type: "string"
        }
      ]
    })
  }
})
