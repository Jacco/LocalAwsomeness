import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Overrides go to a temporary db/ root, so these tests use the real store.
const root = mkdtempSync(join(tmpdir(), 'jpk-quotas-'))
process.env.JPK_DB_ROOT = root

/* eslint-disable @typescript-eslint/no-require-imports */
const { QUOTAS, hardLimit, quota, resetQuota, setQuota } = require('@/app/api/quotas')
const { quotaDefinitions } = require('@/app/api/data/reference')

const A = '111111111111'
const B = '222222222222'

beforeAll(() => {
  for (const account of [A, B]) {
    mkdirSync(join(root, account), { recursive: true })
  }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('quota reference data', () => {
  it('has a definition for every key the code uses, and every definition names its source', () => {
    const definitions = quotaDefinitions()
    for (const key of Object.values(QUOTAS) as string[]) {
      expect(definitions[key]).toBeDefined()
    }
    for (const [key, def] of Object.entries(definitions) as [string, any][]) {
      expect(key.startsWith(`${def.service}.`)).toBe(true)
      expect(Number.isInteger(def.default) && def.default >= 0).toBe(true)
      expect(def.code === null || /^L-[0-9A-F]{8}$/.test(def.code)).toBe(true)
      expect(def.source).toMatch(/^https:\/\/docs\.aws\.amazon\.com\//)
      expect(def.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      // limits nobody can change have no Service Quotas entry; adjustable ones do
      expect(def.adjustable).toBe(def.code !== null)
      if (def.maximum !== undefined) {
        expect(def.maximum).toBeGreaterThanOrEqual(def.default)
      }
    }
  })

  it('has the defaults the services used to hardcode', () => {
    expect(quota({ account: A, region: 'eu-west-1' }, QUOTAS.vpcsPerRegion)).toBe(5)
    expect(quota({ account: A, region: 'eu-west-1' }, QUOTAS.subnetsPerVpc)).toBe(200)
    expect(quota({ account: A, region: 'eu-west-1' }, QUOTAS.rulesPerSecurityGroup)).toBe(60)
    expect(quota({ account: A, region: 'eu-west-1' }, QUOTAS.rulesPerNetworkAcl)).toBe(20)
    expect(hardLimit(QUOTAS.tagsPerResource)).toBe(50)
    expect(hardLimit(QUOTAS.ouNestingDepth)).toBe(5)
    expect(hardLimit(QUOTAS.scpMaxSize)).toBe(10240)
    expect(hardLimit(QUOTAS.rcpMaxSize)).toBe(5120)
  })
})

describe('quota overrides', () => {
  const scope = (account: string, region?: string) => ({ account, region })

  it('applies per account and per region, and goes back to the default when reset', () => {
    setQuota(scope(A, 'eu-west-1'), QUOTAS.vpcsPerRegion, 12)
    expect(quota(scope(A, 'eu-west-1'), QUOTAS.vpcsPerRegion)).toBe(12)
    expect(quota(scope(A, 'eu-central-1'), QUOTAS.vpcsPerRegion)).toBe(5)
    expect(quota(scope(B, 'eu-west-1'), QUOTAS.vpcsPerRegion)).toBe(5)

    setQuota(scope(A, 'eu-central-1'), QUOTAS.vpcsPerRegion, 7)
    expect(quota(scope(A, 'eu-central-1'), QUOTAS.vpcsPerRegion)).toBe(7)
    expect(quota(scope(A, 'eu-west-1'), QUOTAS.vpcsPerRegion)).toBe(12)

    resetQuota(scope(A, 'eu-west-1'), QUOTAS.vpcsPerRegion)
    expect(quota(scope(A, 'eu-west-1'), QUOTAS.vpcsPerRegion)).toBe(5)
    expect(quota(scope(A, 'eu-central-1'), QUOTAS.vpcsPerRegion)).toBe(7)
    resetQuota(scope(A, 'eu-central-1'), QUOTAS.vpcsPerRegion)
    // nothing is left in the file once everything is back to the default
    expect(JSON.parse(readFileSync(join(root, A, 'quotas.json')).toString())).toEqual({ overrides: {} })
  })

  it('refuses limits nobody can change, values above the documented maximum, and unusable scopes', () => {
    expect(() => setQuota(scope(A), QUOTAS.tagsPerResource, 100)).toThrow(/cannot be changed/)
    expect(() => hardLimit(QUOTAS.vpcsPerRegion)).toThrow(/adjustable/)
    expect(() => setQuota(scope(A, 'eu-west-1'), QUOTAS.rulesPerNetworkAcl, 41)).toThrow(/maximum 40/)
    expect(() => setQuota(scope(A, 'eu-west-1'), QUOTAS.vpcsPerRegion, -1)).toThrow(/not valid/)
    expect(() => setQuota(scope(A, 'eu-west-1'), QUOTAS.vpcsPerRegion, 1.5)).toThrow(/not valid/)
    expect(() => quota(scope(A), QUOTAS.vpcsPerRegion)).toThrow(/needs a region/)
    expect(() => quota(scope(A, 'eu-west-1'), 'vpc.nonsense')).toThrow(/Unknown quota/)
    // a value at the maximum is fine
    setQuota(scope(A, 'eu-west-1'), QUOTAS.rulesPerNetworkAcl, 40)
    expect(quota(scope(A, 'eu-west-1'), QUOTAS.rulesPerNetworkAcl)).toBe(40)
    resetQuota(scope(A, 'eu-west-1'), QUOTAS.rulesPerNetworkAcl)
  })
})
