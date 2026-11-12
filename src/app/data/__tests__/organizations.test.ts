import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { provisionAccount } from '"@/app/data/ec2/state'
import {
  getAccount,
  accountExists,
  emailInUse,
  registerAccount,
  findOrg,
  requireOrg,
  requireManagement,
  getPolicy,
  listPolicies,
  createOrganization,
  deleteOrganization,
  enablePolicyType,
  disablePolicyType,
  childrenOf,
  createOrganizationalUnit,
  SCP,
  RCP,
  POLICY_TYPES,
  type OrgState,
} from '"@/app/data/organizations'

// Mock the reference module that loads AWS organization policies
jest.mock('@/app/api/db/reference', () => ({
  // fs is mocked below, so the quota definitions are read with the real one
  quotaDefinitions: jest.fn(() => JSON.parse(jest.requireActual('fs').readFileSync('data/aws/quotas.json', 'utf8'))),
  defaultOrganizationPolicies: jest.fn(() => ({
    'service_control_policy': {
      id: 'service_control_policy',
      name: 'Service Control Policy',
      description: 'Policies that are applied to all principals in the affected accounts',
      content: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: '*',
            Resource: '*',
          },
        ],
      },
    },
  })),
}))

jest.mock('fs')

// Default VPC provisioning has its own tests (ec2.test.ts); here it only needs to be called.
jest.mock('@/app/api/db/ec2/state', () => ({ provisionAccount: jest.fn() }))

const MANAGEMENT = '123456789012'

// An organization in the shape of OrgState: one management account in the root, SCPs and RCPs not yet enabled.
const currentOrg = (overrides: Partial<OrgState> = {}): OrgState => ({
  id: 'o-abcd1234',
  featureSet: 'ALL',
  managementAccountId: MANAGEMENT,
  rootId: 'r-abcd',
  policyTypes: [],
  ous: {},
  members: { [MANAGEMENT]: { parentId: 'r-abcd', joinedMethod: 'CREATED', joinedTimestamp: 1, state: 'ACTIVE' } },
  policies: {},
  attachments: {},
  createAccountRequests: {},
  ...overrides,
})

// The store lists the account directories and reads one file per account; fs is mocked, so say what is "on disk".
function storeHolds(org: unknown) {
  ;(readdirSync as jest.Mock).mockReturnValue([MANAGEMENT])
  ;(statSync as jest.Mock).mockReturnValue({ isDirectory: () => true })
  ;(existsSync as jest.Mock).mockReturnValue(true)
  ;(readFileSync as jest.Mock).mockReturnValue(JSON.stringify(org))
}

describe('Organizations Database Operations', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Account Registry', () => {
    it('should get an account by ID', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      const accounts = [
        {
          id: '123456789012',
          name: 'Production',
          email: 'prod@example.com',
          joinMethod: 'CREATED' as const,
          joinedTimestamp: Date.now(),
          requestedTimestamp: Date.now(),
        },
      ]
      mockRead.mockReturnValue(JSON.stringify(accounts))

      const account = getAccount('123456789012')
      expect(account.id).toBe('123456789012')
      expect(account.name).toBe('Production')
    })

    it('should throw when account not found', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify([]))

      expect(() => getAccount('999999999999')).toThrow('Account not found')
    })

    it('should check if account exists', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      const accounts = [
        {
          id: '123456789012',
          name: 'Production',
          email: 'prod@example.com',
          joinMethod: 'CREATED' as const,
          joinedTimestamp: Date.now(),
          requestedTimestamp: Date.now(),
        },
      ]
      mockRead.mockReturnValue(JSON.stringify(accounts))

      expect(accountExists('123456789012')).toBe(true)
      expect(accountExists('999999999999')).toBe(false)
    })

    it('should check if email is in use (case-insensitive)', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      const accounts = [
        {
          id: '123456789012',
          name: 'Production',
          email: 'prod@example.com',
          joinMethod: 'CREATED' as const,
          joinedTimestamp: Date.now(),
          requestedTimestamp: Date.now(),
        },
      ]
      mockRead.mockReturnValue(JSON.stringify(accounts))

      expect(emailInUse('prod@example.com')).toBe(true)
      expect(emailInUse('PROD@EXAMPLE.COM')).toBe(true)
      expect(emailInUse('other@example.com')).toBe(false)
    })

    it('should register a new account', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>
      const mockMkdir = mkdirSync as jest.MockedFunction<typeof mkdirSync>

      mockExists.mockReturnValue(false)
      mockRead.mockReturnValue(JSON.stringify([]))

      const account = registerAccount('New Account', 'new@example.com', 'CREATED')

      expect(account.id).toBeDefined()
      expect(account.name).toBe('New Account')
      expect(account.email).toBe('new@example.com')
      expect(account.joinMethod).toBe('CREATED')
      expect(mockWrite).toHaveBeenCalled()
      expect(mockMkdir).toHaveBeenCalled()
      expect(provisionAccount).toHaveBeenCalledWith(account.id)
    })

    it('should register account with INVITED join method', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>
      const mockMkdir = mkdirSync as jest.MockedFunction<typeof mkdirSync>

      mockExists.mockReturnValue(false)
      mockRead.mockReturnValue(JSON.stringify([]))

      const account = registerAccount('Invited Account', 'invited@example.com', 'INVITED')

      expect(account.joinMethod).toBe('INVITED')
    })
  })

  describe('Organization State Management', () => {
    it('should find organization', () => {
      storeHolds(currentOrg())

      const org = findOrg(MANAGEMENT)
      expect(org).toBeDefined()
      expect(org?.id).toBe('o-abcd1234')
    })

    it('should return undefined when organization not found', () => {
      storeHolds(currentOrg())

      expect(findOrg('999999999999')).toBeUndefined()
    })

    it('should require organization to exist', () => {
      storeHolds(currentOrg())

      expect(requireOrg(MANAGEMENT).id).toBe('o-abcd1234')
    })

    it('should throw when organization required but missing', () => {
      storeHolds(currentOrg())

      expect(() => requireOrg('999999999999')).toThrow(/not a member of an organization/)
    })

    it('should require management account organization', () => {
      storeHolds(currentOrg())

      expect(requireManagement(MANAGEMENT).managementAccountId).toBe(MANAGEMENT)
    })
  })

  describe('Policy Management', () => {
    const mockOrgState = currentOrg({
      policies: {
        'p-policy1': { id: 'p-policy1', name: 'TestPolicy', type: SCP, description: '', content: { Version: '2012-10-17', Statement: [] }, awsManaged: false },
      },
    })

    it('should get a policy by ID', () => {
      const policy = getPolicy(mockOrgState, 'p-policy1')
      expect(policy.id).toBe('p-policy1')
      expect(policy.name).toBe('TestPolicy')
    })

    it('should throw when policy not found', () => {
      expect(() => getPolicy(mockOrgState, 'p-nonexistent')).toThrow()
    })

    it('should list policies by type', () => {
      const policies = listPolicies(mockOrgState, SCP)
      expect(Array.isArray(policies)).toBe(true)
      policies.forEach(p => {
        expect(p.type).toBe(SCP)
      })
    })

    it('should return empty list for policy type with no policies', () => {
      const policies = listPolicies(mockOrgState, RCP)
      expect(policies).toEqual([])
    })
  })

  describe('Organization Lifecycle', () => {
    it('should create an organization', () => {
      // the account must be registered, and no organization may contain it yet
      ;(readdirSync as jest.Mock).mockReturnValue([])
      ;(existsSync as jest.Mock).mockReturnValue(true)
      ;(readFileSync as jest.Mock).mockReturnValue(JSON.stringify([{ id: MANAGEMENT, name: 'Management', email: 'm@example.com' }]))

      const org = createOrganization(MANAGEMENT, 'ALL')

      expect(org.id).toMatch(/^o-/)
      expect(org.managementAccountId).toBe(MANAGEMENT)
      expect(org.featureSet).toBe('ALL')
      expect(Object.keys(org.members)).toEqual([MANAGEMENT])
      expect(writeFileSync).toHaveBeenCalled()
    })

    it('should refuse to create an organization for an unregistered account', () => {
      ;(readdirSync as jest.Mock).mockReturnValue([])
      ;(existsSync as jest.Mock).mockReturnValue(false)

      expect(() => createOrganization(MANAGEMENT)).toThrow(/permissions/)
    })

    it('should delete an organization that only holds the management account', () => {
      deleteOrganization(currentOrg())
      expect(unlinkSync).toHaveBeenCalledWith(expect.stringContaining(`${MANAGEMENT}/organization.json`))
    })

    it('should not delete an organization that still has other accounts or OUs', () => {
      const other = { parentId: 'r-abcd', joinedMethod: 'CREATED' as const, joinedTimestamp: 1, state: 'ACTIVE' as const }
      expect(() => deleteOrganization(currentOrg({ members: { ...currentOrg().members, '234567890123': other } }))).toThrow(/still contains/)
      expect(() => deleteOrganization(currentOrg({ ous: { 'ou-eng': { id: 'ou-eng', parentId: 'r-abcd', name: 'Eng' } } }))).toThrow(/still contains/)
      expect(unlinkSync).not.toHaveBeenCalled()
    })
  })

  describe('Policy Type Management', () => {
    it('should enable a policy type', () => {
      const org = currentOrg()

      enablePolicyType(org, 'r-abcd', SCP)

      expect(org.policyTypes).toEqual([SCP])
      expect(writeFileSync).toHaveBeenCalled()
      expect(() => enablePolicyType(org, 'r-abcd', SCP)).toThrow(/already enabled/)
    })

    it('should disable a policy type', () => {
      const org = currentOrg({ policyTypes: [SCP] })

      disablePolicyType(org, 'r-abcd', SCP)

      expect(org.policyTypes).toEqual([])
      expect(writeFileSync).toHaveBeenCalled()
      expect(() => disablePolicyType(org, 'r-abcd', SCP)).toThrow(/isn't currently enabled/)
    })

    it('should refuse a root that does not exist', () => {
      expect(() => enablePolicyType(currentOrg(), 'r-other', SCP)).toThrow(/RootId/)
    })
  })

  describe('Organizational Units', () => {
    it('should create an organizational unit', () => {
      const org = currentOrg()

      const ou = createOrganizationalUnit(org, 'r-abcd', 'Engineering')

      expect(ou.name).toBe('Engineering')
      expect(ou.parentId).toBe('r-abcd')
      expect(org.ous[ou.id]).toBe(ou)
      expect(writeFileSync).toHaveBeenCalled()
      expect(() => createOrganizationalUnit(org, 'r-abcd', 'Engineering')).toThrow(/same name/)
    })

    it('should get children of organizational unit', () => {
      const org = currentOrg({ ous: { 'ou-eng': { id: 'ou-eng', parentId: 'r-abcd', name: 'Engineering' } } })

      const children = childrenOf(org, 'r-abcd')

      expect(children.ous.map(ou => ou.id)).toEqual(['ou-eng'])
      expect(children.accounts).toEqual([MANAGEMENT])
      expect(childrenOf(org, 'ou-eng')).toEqual({ ous: [], accounts: [] })
    })
  })

  describe('Policy Types Constant', () => {
    it('should have required policy types', () => {
      expect(POLICY_TYPES).toContain(SCP)
      expect(POLICY_TYPES).toContain(RCP)
      expect(POLICY_TYPES).toContain('TAG_POLICY')
      expect(POLICY_TYPES.length).toBeGreaterThan(0)
    })
  })
})
