import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The limits of Organizations come from the quota reference data. These tests build an organization state by hand, so
// they do not depend on the account registry.
const root = mkdtempSync(join(tmpdir(), 'jpk-org-limits-'))
process.env.JPK_DB_ROOT = root
const MANAGEMENT = '123456789012'

/* eslint-disable @typescript-eslint/no-require-imports */
const { createOrganizationalUnit, createPolicy, RCP, SCP } = require('@/app/api/db/organizations')

const organization = (): any => ({
  id: 'o-test', featureSet: 'ALL', managementAccountId: MANAGEMENT, rootId: 'r-test', policyTypes: [SCP, RCP],
  ous: {}, members: {}, policies: {}, attachments: {}, createAccountRequests: {},
})

// A valid policy document of about `size` characters.
const policyOfSize = (size: number) => {
  const base = JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: '', Effect: 'Deny', Action: 'none:*', Resource: '*' }] })
  return base.replace('"Sid":""', `"Sid":"${'x'.repeat(size - base.length)}"`)
}

beforeAll(() => mkdirSync(join(root, MANAGEMENT), { recursive: true }))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('organizations limits', () => {
  it('allows OUs five levels deep and no deeper', () => {
    const org = organization()
    let parent = org.rootId
    for (let level = 1; level <= 5; level++) {
      parent = createOrganizationalUnit(org, parent, `level-${level}`).id
    }
    expect(() => createOrganizationalUnit(org, parent, 'level-6')).toThrow(/MAX_OU_DEPTH/)
  })

  it('limits the size of a service control policy to 10,240 characters and a resource control policy to 5,120', () => {
    const org = organization()
    expect(policyOfSize(10240)).toHaveLength(10240)
    expect(createPolicy(org, 'big-scp', '', SCP, policyOfSize(10240)).type).toBe(SCP)
    expect(() => createPolicy(org, 'too-big-scp', '', SCP, policyOfSize(10241))).toThrow(/POLICY_CONTENT_LIMIT_EXCEEDED/)

    expect(createPolicy(org, 'big-rcp', '', RCP, policyOfSize(5120)).type).toBe(RCP)
    expect(() => createPolicy(org, 'too-big-rcp', '', RCP, policyOfSize(5121))).toThrow(/POLICY_CONTENT_LIMIT_EXCEEDED/)
  })
})
