import { AwsError } from "../common"
import { assertAccountExists, assertValidRegion, enableByDefaultRegions, optinRegions } from "./common"
import * as store from "./store"

enum RegionOptStatus { 
  ENABLED = "ENABLED",
  DISABLED = "DISABLED",
  ENABLED_BY_DEFAULT = "ENABLED_BY_DEFAULT"
  // state is never: ENABLING | DISABLING
}

enum AlternateContactType {
  BILLING = "BILLING",
  OPERATIONS = "OPERATIONS",
  SECURITY = "SECURITY",
}

interface Regions { [region: string]: RegionOptStatus | undefined }

function assertValidAlternateContactType(type: AlternateContactType) {
  if(!Object.values(AlternateContactType).includes(type)) {
    throw new AwsError('ValidationException', `${type} is not in BILLING OPERATIONS SECURITY`)
  }
}

const accountKey = (account: string): store.StoreKey => ({ service: 'account', account })

function loadSection(account: string, section: string): any {
  return store.read<Record<string, any>>(accountKey(account), {})[section] ?? {}
}

// An empty section is dropped so account.json does not accumulate empty objects.
function saveSection(account: string, section: string, value: any, keepEmpty = false) {
  store.update<Record<string, any>>(accountKey(account), {}, contents => {
    contents[section] = keepEmpty || Object.values(value).some(Boolean) ? value : undefined
  })
}

const loadAccountRegionOptStatus = (account: string): Regions => loadSection(account, 'regions')
const saveAccountRegionOptStatus = (account: string, regions: Regions) => saveSection(account, 'regions', regions)
const loadContactInformation = (account: string): any => loadSection(account, 'contact')
const saveContactInformation = (account: string, info: any) => saveSection(account, 'contact', info, true)
const loadAlternateContact = (account: string): any => loadSection(account, 'alternate')
const saveAlternateContact = (account: string, info: any) => saveSection(account, 'alternate', info)

export function enableRegion(account: string, region: string) {
  assertValidRegion(region)
  assertAccountExists(account)
  if (enableByDefaultRegions.includes(region)) {
    return
  }
  const regions = loadAccountRegionOptStatus(account)
  regions[region] = RegionOptStatus.ENABLED
  saveAccountRegionOptStatus(account, regions)
}

export function disableRegion(account: string, region: string) {
  assertValidRegion(region)
  assertAccountExists(account)
  if (enableByDefaultRegions.includes(region)) {
    throw new AwsError('ValidationException', `Region ${region} cannot be disabled (it is enabled by default)`)
  }
  const regions = loadAccountRegionOptStatus(account)
  regions[region] = undefined
  saveAccountRegionOptStatus(account, regions)
}

export function listRegions(account: string): Regions {
  assertAccountExists(account)
  const regions = loadAccountRegionOptStatus(account)
  for (const region of enableByDefaultRegions) {
    regions[region] = RegionOptStatus.ENABLED_BY_DEFAULT
  }
  for (const region of optinRegions) {
    if (!(region in regions)) {
      regions[region] = RegionOptStatus.DISABLED
    }
  }
  return regions
}

export function getRegion(account: string, region: string): RegionOptStatus {
  assertValidRegion(region)
  assertAccountExists(account)
  if (enableByDefaultRegions.includes(region)) {
    return RegionOptStatus.ENABLED_BY_DEFAULT
  }
  const regions = loadAccountRegionOptStatus(account)
  if (region in regions) {
    return regions[region]!
  }
  return RegionOptStatus.DISABLED
}

export function putContactInformation(account: string, contactInformation: any) {
  assertAccountExists(account)
  saveContactInformation(account, contactInformation)
}

export function getContactInformation(account: string): any {
  assertAccountExists(account)
  return loadContactInformation(account)
}

export function putAlternateContact(account: string, alternateContactType: AlternateContactType, alternateContact: any) {
  assertAccountExists(account)
  assertValidAlternateContactType(alternateContactType)
  const alternate = loadAlternateContact(account)
  alternate[alternateContactType] = alternateContact
  saveAlternateContact(account, alternate)
}

export function getAlternateContact(account: string, alternateContactType: AlternateContactType): any {
  assertAccountExists(account)
  assertValidAlternateContactType(alternateContactType)
  const alternate = loadAlternateContact(account)
  return alternate[alternateContactType]
}

export function deleteAlternateContact(account: string, alternateContactType: AlternateContactType) {
  assertAccountExists(account)
  assertValidAlternateContactType(alternateContactType)
  const alternate = loadAlternateContact(account)
  alternate[alternateContactType] = undefined
  saveAlternateContact(account, alternate)
}

export function putAccountName(account: string, name: string) {
  assertAccountExists(account)
  const accountsKey: store.StoreKey = { service: 'accounts' }
  const accounts = store.read<any[]>(accountsKey, [])
  const idx = accounts.findIndex((x: any) => x.id == account)
  if (idx === -1) {
    throw new AwsError('ResourceNotFoundException', 'Account not found', 404)
  }
  accounts[idx].name = name
  store.write(accountsKey, accounts)
}
