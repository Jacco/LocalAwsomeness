
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import { assertAccountExists, assertValidRegion, PARTITION } from "./common"

function loadSsmSection(account: string, region: string, section: string) {
  const fn = `db/${account}/${region}/ssm.json`
  let contents: any = {}
  if (existsSync(fn)) {
    contents = JSON.parse(readFileSync(fn).toString())
  }
  if (section in contents) {
    contents = contents[section]
  }
  return contents
}

function saveSsmSection(account: string, region: string, section: string, sectionContents: any) {
  const fn = `db/${account}/${region}/ssm.json`
  let contents: { [key: string]: any } = {}
  if (existsSync(fn)) {
    contents = JSON.parse(readFileSync(fn).toString())
  } else {
    mkdirSync(path.dirname(fn), { recursive: true })
  }
  contents[section] = sectionContents
  writeFileSync(fn, JSON.stringify(contents, null, 2))
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

export interface SsmPutParameterProps {
  name: string
  value: string
  dataType?: SsmParameterDataType
  tier?: SsmParameterTier
}

export function putParameter(
  account: string, 
  region: string, 
  props: SsmPutParameterProps
) {
  const parameters = loadSsmSection(account, region, 'parameters')
  let version = 0
  if (props.name in parameters) {
    version = parameters[props.name].Version
    // TODO check overwrite
  }
  const tierSetting = getServiceSetting(account, region, "/ssm/parameter-store/default-parameter-tier").SettingValue
  parameters[props.name] = {
    DataType: props.dataType ?? SsmParameterDataType.Text,
    LastModifiedDate: new Date().valueOf()/1000,
    Name: props.name,
    Selector: "string",
    SourceResult: "string",
    Type: "string",
    Value: props.value,
    Version: version+1,
    Tier: props.tier ?? tierSetting
  }
  saveSsmSection(account, region, 'parameters', parameters)
  return {
    Tier: tierSetting,
    Version: version
  }
}

export function getParameter(account: string, region: string, name: string) {
  assertAccountExists(account)
  assertValidRegion(region)
  // TODO name:label name:version
  // TODO withdecrytpion
  const parameters = loadSsmSection(account, region, 'parameters')
  if (!(name in parameters)) {
    throw Error(`Parameter ${name} not found`)
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
    throw Error(`${settingId} does not exist`)
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
    throw Error(`${settingId} does not exist`)
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