import { existsSync, readFileSync, writeFileSync } from "fs"
import { assertAccountExists, assertValidRegion, enableByDefaultRegions, optinRegions } from "./common"

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
    throw Error(`${type} is not in BILLING OPERATIONS SECURITY`)
  }
}

function loadAccountRegionOptStatus(account: string): Regions {
  const fn = `db/${account}/account.json`
  let regions: Regions = {}
  if (existsSync(fn)) {
    const contents = JSON.parse(readFileSync(fn).toString())
    if ('regions' in contents) {
      regions = contents['regions']
    }
  }
  return regions
}

function saveAccountRegionOptStatus(account: string, regions: Regions) {
  const fn = `db/${account}/account.json`
  let contents: any = {}
  if (existsSync(fn)) {
    contents = JSON.parse(readFileSync(fn).toString())
  }
  if (Object.values(regions).filter(Boolean).length > 0) {
    contents['regions'] = regions
  } else {
    contents['regions'] = undefined
  }
  writeFileSync(fn, JSON.stringify(contents, null, 2))
}

function loadContactInformation(account: string): Regions {
  const fn = `db/${account}/account.json`
  let info: any = {}
  if (existsSync(fn)) {
    const contents = JSON.parse(readFileSync(fn).toString())
    if ('contact' in contents) {
      info = contents['contact']
    }
  }
  return info
}

function saveContactInformation(account: string, info: any) {
  const fn = `db/${account}/account.json`
  let contents: any = {}
  if (existsSync(fn)) {
    contents = JSON.parse(readFileSync(fn).toString())
  }
  contents['contact'] = info
  writeFileSync(fn, JSON.stringify(contents, null, 2))
}

function loadAlternateContact(account: string): Regions {
  const fn = `db/${account}/account.json`
  let info: any = {}
  if (existsSync(fn)) {
    const contents = JSON.parse(readFileSync(fn).toString())
    if ('alternate' in contents) {
      info = contents['alternate']
    }
  }
  return info
}

function saveAlternateContact(account: string, info: any) {
  const fn = `db/${account}/account.json`
  let contents: any = {}
  if (existsSync(fn)) {
    contents = JSON.parse(readFileSync(fn).toString())
  }
  if (Object.values(info).filter(Boolean).length > 0) {
    contents['alternate'] = info
  } else {
    contents['alternate'] = undefined
  }
  writeFileSync(fn, JSON.stringify(contents, null, 2))
}

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
    throw Error(`Region ${region} cannot be disabled (it is enabled by default)`)
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
  const fn = 'db/accounts.json'
  const accounts = JSON.parse(readFileSync(fn).toString())
  const idx = accounts.findIndex((x: any) => x.id == account)
  if (idx === -1) {
    throw Error('Account not found')
  }
  accounts[idx].name = name
  writeFileSync(fn, JSON.stringify(accounts, null, 2))
}
