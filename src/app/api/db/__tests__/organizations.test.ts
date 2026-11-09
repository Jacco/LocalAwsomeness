import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
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
} from '@/app/api/db/organizations'

// Mock the reference module that loads AWS organization policies
jest.mock('@/app/api/db/reference', () => ({
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
    const mockOrgState = {
      id: 'o-abcd1234',
      arn: 'arn:aws:organizations::123456789012:organization/o-abcd1234',
      featureSet: 'ALL',
      managementAccountId: '123456789012',
      managementAccountArn: 'arn:aws:organizations::123456789012:account/o-abcd1234/123456789012',
      rootId: 'r-abcd',
      policies: {},
      roots: [],
      organizationalUnits: [],
      accountTree: {},
    }

    it('should find organization', () => {
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify(mockOrgState))

      const org = findOrg('123456789012')
      expect(org).toBeDefined()
      expect(org?.id).toBe('o-abcd1234')
    })

    it('should return undefined when organization not found', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      mockExists.mockReturnValue(false)

      const org = findOrg('999999999999')
      expect(org).toBeUndefined()
    })

    it('should require organization to exist', () => {
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify(mockOrgState))

      const org = requireOrg('123456789012')
      expect(org.id).toBe('o-abcd1234')
    })

    it('should throw when organization required but missing', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      mockExists.mockReturnValue(false)

      expect(() => requireOrg('999999999999')).toThrow()
    })

    it('should require management account organization', () => {
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify(mockOrgState))

      const org = requireManagement('123456789012')
      expect(org.managementAccountId).toBe('123456789012')
    })
  })

  describe('Policy Management', () => {
    const mockOrgState = {
      id: 'o-abcd1234',
      arn: 'arn:aws:organizations::123456789012:organization/o-abcd1234',
      featureSet: 'ALL',
      managementAccountId: '123456789012',
      managementAccountArn: 'arn:aws:organizations::123456789012:account/o-abcd1234/123456789012',
      rootId: 'r-abcd',
      policies: {
        'p-policy1': {
          id: 'p-policy1',
          name: 'TestPolicy',
          type: SCP,
          arn: 'arn:aws:organizations::123456789012:policy/SCP/p-policy1',
          content: '{}',
          aWSManaged: false,
          targets: [],
        },
      },
      roots: [],
      organizationalUnits: [],
      accountTree: {},
    }

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
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>
      const mockMkdir = mkdirSync as jest.MockedFunction<typeof mkdirSync>

      mockExists.mockReturnValue(false)

      const org = createOrganization('123456789012', 'ALL')

      expect(org.id).toBeDefined()
      expect(org.managementAccountId).toBe('123456789012')
      expect(org.featureSet).toBe('ALL')
      expect(mockWrite).toHaveBeenCalled()
    })

    it('should delete an organization', () => {
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      const org = {
        id: 'o-abcd1234',
        arn: 'arn:aws:organizations::123456789012:organization/o-abcd1234',
        featureSet: 'ALL',
        managementAccountId: '123456789012',
        managementAccountArn: 'arn:aws:organizations::123456789012:account/o-abcd1234/123456789012',
        rootId: 'r-abcd',
        policies: {},
        roots: [],
        organizationalUnits: [],
        accountTree: {},
      }

      deleteOrganization(org)
      expect(mockWrite).toHaveBeenCalled()
    })
  })

  describe('Policy Type Management', () => {
    it('should enable a policy type', () => {
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      const org = {
        id: 'o-abcd1234',
        arn: 'arn:aws:organizations::123456789012:organization/o-abcd1234',
        featureSet: 'ALL',
        managementAccountId: '123456789012',
        managementAccountArn: 'arn:aws:organizations::123456789012:account/o-abcd1234/123456789012',
        rootId: 'r-abcd',
        policies: {},
        roots: [
          {
            id: 'r-abcd',
            arn: 'arn:aws:organizations::123456789012:root/o-abcd1234/r-abcd',
            name: 'Root',
            policyTypes: [],
          },
        ],
        organizationalUnits: [],
        accountTree: {},
      }

      enablePolicyType(org, 'r-abcd', SCP)
      expect(mockWrite).toHaveBeenCalled()
    })

    it('should disable a policy type', () => {
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      const org = {
        id: 'o-abcd1234',
        arn: 'arn:aws:organizations::123456789012:organization/o-abcd1234',
        featureSet: 'ALL',
        managementAccountId: '123456789012',
        managementAccountArn: 'arn:aws:organizations::123456789012:account/o-abcd1234/123456789012',
        rootId: 'r-abcd',
        policies: {},
        roots: [
          {
            id: 'r-abcd',
            arn: 'arn:aws:organizations::123456789012:root/o-abcd1234/r-abcd',
            name: 'Root',
            policyTypes: [{ type: SCP, status: 'ENABLED' }],
          },
        ],
        organizationalUnits: [],
        accountTree: {},
      }

      disablePolicyType(org, 'r-abcd', SCP)
      expect(mockWrite).toHaveBeenCalled()
    })
  })

  describe('Organizational Units', () => {
    it('should create an organizational unit', () => {
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      const org = {
        id: 'o-abcd1234',
        arn: 'arn:aws:organizations::123456789012:organization/o-abcd1234',
        featureSet: 'ALL',
        managementAccountId: '123456789012',
        managementAccountArn: 'arn:aws:organizations::123456789012:account/o-abcd1234/123456789012',
        rootId: 'r-abcd',
        policies: {},
        roots: [
          {
            id: 'r-abcd',
            arn: 'arn:aws:organizations::123456789012:root/o-abcd1234/r-abcd',
            name: 'Root',
            policyTypes: [],
          },
        ],
        organizationalUnits: [],
        accountTree: {},
      }

      const ou = createOrganizationalUnit(org, 'r-abcd', 'Engineering')
      expect(ou.name).toBe('Engineering')
      expect(ou.parentId).toBe('r-abcd')
      expect(mockWrite).toHaveBeenCalled()
    })

    it('should get children of organizational unit', () => {
      const org = {
        id: 'o-abcd1234',
        arn: 'arn:aws:organizations::123456789012:organization/o-abcd1234',
        featureSet: 'ALL',
        managementAccountId: '123456789012',
        managementAccountArn: 'arn:aws:organizations::123456789012:account/o-abcd1234/123456789012',
        rootId: 'r-abcd',
        policies: {},
        roots: [],
        organizationalUnits: [],
        accountTree: {
          'r-abcd': {
            ous: [
              {
                id: 'ou-eng',
                parentId: 'r-abcd',
                name: 'Engineering',
                arn: 'arn:aws:organizations::123456789012:ou/o-abcd1234/ou-eng',
              },
            ],
            accounts: ['123456789012', '234567890123'],
          },
        },
      }

      const children = childrenOf(org, 'r-abcd')
      expect(children.ous.length).toBeGreaterThan(0)
      expect(children.accounts.length).toBeGreaterThan(0)
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
