import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import {
  PolicyScope,
  listPolicies,
  parsePolicyDocument,
  getRole,
  findRole,
  createRole,
  listRoles,
  deleteRole,
  putRolePolicy,
  getRolePolicy,
  deleteRolePolicy,
  attachRolePolicy,
  detachRolePolicy,
  trustAllows,
  attachmentCounts,
} from '@/app/api/data/iam'

// Mock the reference module that loads AWS managed policies
jest.mock('@/app/api/data/reference', () => ({
  listManagedPolicies: jest.fn(() => [
    {
      name: 'AWSLambdaExecute',
      path: '/service-role/',
      arn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaExecute',
      policyId: 'ANPAI23HZ27SI6FQMGNHQ',
      description: 'Provides write permissions to CloudWatch Logs',
      defaultVersion: 'v4',
      versions: ['v4', 'v3', 'v2', 'v1'],
      documents: {
        v4: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['logs:*'],
              Resource: 'arn:aws:logs:*:*:*',
            },
          ],
        },
      },
    },
    {
      name: 'AmazonS3ReadOnlyAccess',
      path: '/',
      arn: 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess',
      policyId: 'ANPAI23HZ27SI6FQMGNHQ',
      description: 'S3 read only',
      defaultVersion: 'v1',
      versions: ['v1'],
      documents: {
        v1: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['s3:Get*', 's3:List*'],
              Resource: '*',
            },
          ],
        },
      },
    },
  ]),
  findManagedPolicy: jest.fn((arn: string) => {
    const policies: Record<string, any> = {
      'arn:aws:iam::aws:policy/service-role/AWSLambdaExecute': {
        name: 'AWSLambdaExecute',
        path: '/service-role/',
        arn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaExecute',
        policyId: 'ANPAI23HZ27SI6FQMGNHQ',
      },
      'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess': {
        name: 'AmazonS3ReadOnlyAccess',
        path: '/',
        arn: 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess',
        policyId: 'ANPAI23HZ27SI6FQMGNHQ',
      },
    }
    return policies[arn]
  }),
  defaultOrganizationPolicies: jest.fn(() => ({})),
}))

// Mock common validation functions
jest.mock('@/app/api/data/common', () => ({
  assertAccountExists: jest.fn(),
  assertValidRegion: jest.fn(),
  PARTITION: 'aws',
}))

jest.mock('fs')

describe('IAM Database Operations', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Policy Management', () => {
    it('should list policies with default scope (All)', () => {
      const policies = listPolicies('123456789012')
      expect(policies).toBeDefined()
      expect(Array.isArray(policies)).toBe(true)
    })

    it('should list policies with AWS scope', () => {
      const policies = listPolicies('123456789012', PolicyScope.AWS)
      expect(Array.isArray(policies)).toBe(true)
    })

    it('should list local policies (always empty)', () => {
      const policies = listPolicies('123456789012', PolicyScope.Local)
      expect(policies).toEqual([])
    })

    it('should filter policies by path prefix', () => {
      const policiesAll = listPolicies('123456789012', PolicyScope.All, '/')
      const policiesCustom = listPolicies('123456789012', PolicyScope.All, '/custom/')
      expect(Array.isArray(policiesAll)).toBe(true)
      expect(Array.isArray(policiesCustom)).toBe(true)
    })
  })

  describe('Policy Document Parsing', () => {
    it('should parse valid policy document', () => {
      const validPolicy = '{"Statement":[{"Effect":"Allow","Action":"s3:*","Resource":"*"}]}'
      const parsed = parsePolicyDocument(validPolicy)
      expect(parsed).toHaveProperty('Statement')
      expect(Array.isArray(parsed.Statement)).toBe(true)
    })

    it('should throw for invalid JSON', () => {
      const invalidJson = '{invalid json}'
      expect(() => parsePolicyDocument(invalidJson)).toThrow(expect.objectContaining({ type: 'MalformedPolicyDocument' }))
    })

    it('should throw for missing Statement', () => {
      const noStatement = '{"Version":"2012-10-17"}'
      expect(() => parsePolicyDocument(noStatement)).toThrow(expect.objectContaining({ type: 'MalformedPolicyDocument' }))
    })

    it('should handle complex policy documents', () => {
      const complexPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['s3:GetObject', 's3:PutObject'],
            Resource: 'arn:aws:s3:::bucket/*',
          },
        ],
      })
      const parsed = parsePolicyDocument(complexPolicy)
      expect(parsed.Statement.length).toBeGreaterThan(0)
    })
  })

  describe('Role CRUD Operations', () => {
    it('should create a role with persistence', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>
      const mockMkdir = mkdirSync as jest.MockedFunction<typeof mkdirSync>

      mockExists.mockReturnValue(false)
      mockRead.mockReturnValue(JSON.stringify({ roles: {} }))

      const trustPolicy = { Statement: [] }
      const role = createRole('123456789012', {
        roleName: 'TestRole',
        path: '/',
        assumeRolePolicyDocument: trustPolicy,
      })

      expect(role.roleName).toBe('TestRole')
      expect(role.roleId).toBeDefined()
      expect(mockWrite).toHaveBeenCalled()
    })

    it('should list all roles', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          roles: {
            'Role1': {
              roleName: 'Role1',
              roleId: 'AIDAR123',
              path: '/',
              arn: 'arn:aws:iam::123456789012:role/Role1',
              createDate: Date.now(),
              assumeRolePolicyDocument: { Statement: [] },
              maxSessionDuration: 3600,
              inlinePolicies: {},
              attachedPolicies: [],
            },
          },
        })
      )

      const roles = listRoles('123456789012')
      expect(Array.isArray(roles)).toBe(true)
      expect(roles.length).toBeGreaterThan(0)
    })

    it('should get a specific role', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      const testRole = {
        roleName: 'TestRole',
        roleId: 'AIDAR123',
        path: '/',
        arn: 'arn:aws:iam::123456789012:role/TestRole',
        createDate: Date.now(),
        assumeRolePolicyDocument: { Statement: [] },
        maxSessionDuration: 3600,
        inlinePolicies: {},
        attachedPolicies: [],
      }
      mockRead.mockReturnValue(JSON.stringify({ roles: { 'TestRole': testRole } }))

      const role = getRole('123456789012', 'TestRole')
      expect(role.roleName).toBe('TestRole')
    })

    it('should find role or return undefined', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify({ roles: {} }))

      const role = findRole('123456789012', 'NonExistentRole')
      expect(role).toBeUndefined()
    })

    it('should delete a role', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      const testRole = {
        roleName: 'TestRole',
        roleId: 'AIDAR123',
        path: '/',
        arn: 'arn:aws:iam::123456789012:role/TestRole',
        createDate: Date.now(),
        assumeRolePolicyDocument: { Statement: [] },
        maxSessionDuration: 3600,
        inlinePolicies: {},
        attachedPolicies: [],
      }
      mockRead.mockReturnValue(JSON.stringify({ roles: { 'TestRole': testRole } }))

      deleteRole('123456789012', 'TestRole')

      expect(mockWrite).toHaveBeenCalled()
      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.roles['TestRole']).toBeUndefined()
    })
  })

  describe('Role Inline Policies', () => {
    it('should put an inline policy on a role', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      const testRole = {
        roleName: 'TestRole',
        roleId: 'AIDAR123',
        path: '/',
        arn: 'arn:aws:iam::123456789012:role/TestRole',
        createDate: Date.now(),
        assumeRolePolicyDocument: { Statement: [] },
        maxSessionDuration: 3600,
        inlinePolicies: {},
        attachedPolicies: [],
      }
      mockRead.mockReturnValue(JSON.stringify({ roles: { 'TestRole': testRole } }))

      const policyDoc = { Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] }
      putRolePolicy('123456789012', 'TestRole', 'S3AccessPolicy', policyDoc)

      expect(mockWrite).toHaveBeenCalled()
      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.roles['TestRole'].inlinePolicies.S3AccessPolicy).toBeDefined()
    })

    it('should get an inline policy from a role', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      const policyDoc = { Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] }
      const testRole = {
        roleName: 'TestRole',
        roleId: 'AIDAR123',
        path: '/',
        arn: 'arn:aws:iam::123456789012:role/TestRole',
        createDate: Date.now(),
        assumeRolePolicyDocument: { Statement: [] },
        maxSessionDuration: 3600,
        inlinePolicies: { S3AccessPolicy: policyDoc },
        attachedPolicies: [],
      }
      mockRead.mockReturnValue(JSON.stringify({ roles: { 'TestRole': testRole } }))

      const policy = getRolePolicy('123456789012', 'TestRole', 'S3AccessPolicy')
      expect(policy).toEqual(policyDoc)
    })

    it('should delete an inline policy from a role', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      const policyDoc = { Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] }
      const testRole = {
        roleName: 'TestRole',
        roleId: 'AIDAR123',
        path: '/',
        arn: 'arn:aws:iam::123456789012:role/TestRole',
        createDate: Date.now(),
        assumeRolePolicyDocument: { Statement: [] },
        maxSessionDuration: 3600,
        inlinePolicies: { S3AccessPolicy: policyDoc },
        attachedPolicies: [],
      }
      mockRead.mockReturnValue(JSON.stringify({ roles: { 'TestRole': testRole } }))

      deleteRolePolicy('123456789012', 'TestRole', 'S3AccessPolicy')

      expect(mockWrite).toHaveBeenCalled()
      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.roles['TestRole'].inlinePolicies.S3AccessPolicy).toBeUndefined()
    })
  })

  describe('Managed Policy Attachment', () => {
    it('should attach a managed policy to a role', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      const testRole = {
        roleName: 'TestRole',
        roleId: 'AIDAR123',
        path: '/',
        arn: 'arn:aws:iam::123456789012:role/TestRole',
        createDate: Date.now(),
        assumeRolePolicyDocument: { Statement: [] },
        maxSessionDuration: 3600,
        inlinePolicies: {},
        attachedPolicies: [],
      }
      mockRead.mockReturnValue(JSON.stringify({ roles: { 'TestRole': testRole } }))

      attachRolePolicy('123456789012', 'TestRole', 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess')

      expect(mockWrite).toHaveBeenCalled()
      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.roles['TestRole'].attachedPolicies).toContain(
        'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess'
      )
    })

    it('should detach a managed policy from a role', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      const testRole = {
        roleName: 'TestRole',
        roleId: 'AIDAR123',
        path: '/',
        arn: 'arn:aws:iam::123456789012:role/TestRole',
        createDate: Date.now(),
        assumeRolePolicyDocument: { Statement: [] },
        maxSessionDuration: 3600,
        inlinePolicies: {},
        attachedPolicies: ['arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess'],
      }
      mockRead.mockReturnValue(JSON.stringify({ roles: { 'TestRole': testRole } }))

      detachRolePolicy('123456789012', 'TestRole', 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess')

      expect(mockWrite).toHaveBeenCalled()
      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.roles['TestRole'].attachedPolicies).not.toContain(
        'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess'
      )
    })
  })

  describe('Trust Policy Analysis', () => {
    it('should determine if trust policy allows caller', () => {
      const role = {
        roleName: 'TestRole',
        roleId: 'AIDAR123',
        path: '/',
        arn: 'arn:aws:iam::123456789012:role/TestRole',
        createDate: Date.now(),
        assumeRolePolicyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: 'arn:aws:iam::123456789012:root' },
              Action: 'sts:AssumeRole',
            },
          ],
        },
        maxSessionDuration: 3600,
        inlinePolicies: {},
        attachedPolicies: [],
      }

      const allows = trustAllows(role, 'arn:aws:iam::123456789012:root')
      expect(typeof allows).toBe('boolean')
    })
  })

  describe('Attachment Counts', () => {
    it('should count policy attachments per role', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          roles: {
            AIDAR123: {
              roleName: 'Role1',
              roleId: 'AIDAR123',
              path: '/',
              arn: 'arn:aws:iam::123456789012:role/Role1',
              createDate: Date.now(),
              assumeRolePolicyDocument: { Statement: [] },
              maxSessionDuration: 3600,
              inlinePolicies: { Policy1: {}, Policy2: {} },
              attachedPolicies: ['arn:aws:iam::aws:policy/Policy1'],
            },
          },
        })
      )

      // keyed by the ARN of the attached policy
      const counts = attachmentCounts('123456789012')
      expect(counts['arn:aws:iam::aws:policy/Policy1']).toBe(1)
    })
  })
})
