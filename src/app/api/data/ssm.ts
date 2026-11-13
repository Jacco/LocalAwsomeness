
import { AwsError } from "../common"
import { assertAccountExists, assertValidRegion, PARTITION } from "./common"
import * as store from "./store"

const ssmKey = (account: string, region: string): store.StoreKey => ({ service: 'ssm', account, region })

function loadSsmSection(account: string, region: string, section: string) {
  return store.read<Record<string, any>>(ssmKey(account, region), {})[section] ?? {}
}

function saveSsmSection(account: string, region: string, section: string, sectionContents: any) {
  store.update<Record<string, any>>(ssmKey(account, region), {}, contents => {
    contents[section] = sectionContents
  })
}

enum SsmParameterDataType {
  Text = "text",
  Image = "aws:ec2:image",
  Integration = "aws:ssm:integration"
}

enum SsmParameterTier {
  Standard = "Standard",
  Advanced = "Advanced",
  IntelligentTiering = "Intelligent-Tiering"
}

export type SsmParameterType = 'String' | 'StringList' | 'SecureString'
const PARAMETER_TYPES: SsmParameterType[] = ['String', 'StringList', 'SecureString']

export interface SsmPutParameterProps {
  name: string
  value: string
  type?: SsmParameterType
  description?: string
  allowedPattern?: string
  overwrite?: boolean
  tags?: { Key: string; Value: string }[]
  dataType?: SsmParameterDataType
  tier?: SsmParameterTier
}

export function putParameter(
  account: string, 
  region: string, 
  props: SsmPutParameterProps
) {
  const parameters = loadSsmSection(account, region, 'parameters')
  const existing = parameters[props.name]
  if (existing && !props.overwrite) {
    throw new AwsError('ParameterAlreadyExists', 'The parameter already exists. To overwrite this value, set the overwrite option in the request to true.')
  }
  if (existing && props.tags?.length) {
    throw new AwsError('ValidationException', 'Invalid request: tags and overwrite can\'t be used together. To create a parameter with tags, please remove overwrite flag. To update tags for an existing parameter, please use AddTagsToResource or RemoveTagsFromResource.')
  }
  if (props.type !== undefined && !PARAMETER_TYPES.includes(props.type)) {
    throw new AwsError('ValidationException', `1 validation error detected: Value '${props.type}' at 'type' failed to satisfy constraint: Member must satisfy enum value set: [SecureString, StringList, String]`)
  }
  const allowedPattern = props.allowedPattern ?? existing?.AllowedPattern
  if (allowedPattern && !new RegExp(allowedPattern).test(props.value)) {
    throw new AwsError('ParameterPatternMismatchException', `Parameter value, cannot be validated against allowedPattern: ${allowedPattern}`)
  }
  const description = props.description ?? existing?.Description
  const tags = existing?.Tags ?? props.tags
  const version = existing?.Version ?? 0
  const tierSetting = getServiceSetting(account, region, "/ssm/parameter-store/default-parameter-tier").SettingValue
  parameters[props.name] = {
    DataType: props.dataType ?? SsmParameterDataType.Text,
    LastModifiedDate: new Date().valueOf()/1000,
    Name: props.name,
    Selector: "string",
    SourceResult: "string",
    // AWS requires a Type to create a parameter; the simulator defaults to String. An update keeps the type.
    Type: props.type ?? existing?.Type ?? 'String',
    Value: props.value,
    Version: version+1,
    Tier: props.tier ?? tierSetting,
    ...(description !== undefined && { Description: description }),
    ...(allowedPattern && { AllowedPattern: allowedPattern }),
    ...(tags && { Tags: tags }),
  }
  saveSsmSection(account, region, 'parameters', parameters)
  return {
    Tier: tierSetting,
    Version: version + 1
  }
}

export function deleteParameter(account: string, region: string, name: string) {
  assertAccountExists(account)
  assertValidRegion(region)
  const parameters = loadSsmSection(account, region, 'parameters')
  if (!(name in parameters)) {
    throw new AwsError('ParameterNotFound', `Parameter ${name} not found`)
  }
  delete parameters[name]
  saveSsmSection(account, region, 'parameters', parameters)
}

export function getParameter(account: string, region: string, name: string) {
  assertAccountExists(account)
  assertValidRegion(region)
  // TODO name:label name:version
  // TODO withdecrytpion
  const parameters = loadSsmSection(account, region, 'parameters')
  if (!(name in parameters)) {
    throw new AwsError('ParameterNotFound', `Parameter ${name} not found`)
  }
  const parameter = parameters[name]
  const result = {
    ARN: `arn:${PARTITION}:ssm:${region}:${account}:parameter/${name}`,
    DataType: parameter.DataType,
    LastModifiedDate: parameter.LastModifiedDate,
    Name: parameter.Name,
    Selector: parameter.Selector,
    SourceResult: parameter.SourceResult,
    Type: parameter.Type,
    Value: parameter.Value,
    Version: parameter.Version
  }
  return result
}

// TODO move to a JSON like awsiam.json
const ssmServiceSettings: { [settingId: string]: string } = {
  "/ssm/appmanager/appmanager-enabled"                        : "False",
  "/ssm/automation/customer-script-log-destination"           : "None",
  "/ssm/automation/customer-script-log-group-name"            : "/aws/ssm/automation/executeScript",
  "/ssm/automation/enable-adaptive-concurrency"               : "False",
  "/ssm/documents/console/public-sharing-permission"          : "Enable",
  "/ssm/managed-instance/activation-tier"                     : "standard",
  "/ssm/managed-instance/default-ec2-instance-management-role": "$None",
  "/ssm/opsinsights/opscenter"                                : "Disabled",
  "/ssm/parameter-store/default-parameter-tier"               : "Standard",
  "/ssm/parameter-store/high-throughput-enabled"              : "false",
}

enum SsmServiceSettingStatus {
  Default = "Default",
  Customized = "Customized", 
  // PendingUpdate = "PendingUpdate", not used in JackStack
}

interface SsmServiceSetting {
  SettingId: string,
  SettingValue: string,
  LastModifiedDate: number,
  LastModifiedUser: string,
  ARN: string,
  Status: SsmServiceSettingStatus
}

export function getServiceSetting(account: string, region: string, settingId: string): SsmServiceSetting {
  assertAccountExists(account)
  assertValidRegion(region)
  if (!(settingId in ssmServiceSettings)) {
    throw new AwsError('ServiceSettingNotFound', `${settingId} does not exist`)
  }
  const settings = loadSsmSection(account, region, 'settings')
  let value = settingId in settings ? settings[settingId] : {
    SettingId: settingId,
    SettingValue: ssmServiceSettings[settingId],
    LastModifiedDate: 1566243740.821,
    LastModifiedUser: "System",
    ARN: `arn:aws:ssm:${region}:${account}:servicesetting${settingId}`,
    Status: SsmServiceSettingStatus.Default
  }
  return value
}

export function setServiceSetting(account: string, region: string, settingId: string, value: string, user: string) {
  assertAccountExists(account)
  assertValidRegion(region)
  if (!(settingId in ssmServiceSettings)) {
    throw new AwsError('ServiceSettingNotFound', `${settingId} does not exist`)
  }
  const settings = loadSsmSection(account, region, 'settings')
  settings[settingId] = {
    SettingId: settingId,
    SettingValue: value,
    LastModifiedDate: new Date().valueOf(), // TODO verify format 1566243740.821,
    LastModifiedUser: user,
    ARN: `arn:aws:ssm:${region}:${account}:servicesetting${settingId}`,
    Status: SsmServiceSettingStatus.Customized
  }
  saveSsmSection(account, region, 'settings', settings)
}