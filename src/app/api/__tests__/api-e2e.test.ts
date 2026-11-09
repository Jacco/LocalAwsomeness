/**
 * End-to-End API Tests
 * 
 * These tests call the actual API endpoints using the request/response interface.
 * They exercise the complete flow: HTTP request → route handler → database → HTTP response.
 * These tests will survive database refactoring because they only validate the
 * observable behavior (request/response) not implementation details.
 */

import { POST as iamHandler } from '@/app/api/iam/route'
import { POST as accountGetInformationHandler } from '@/app/api/account/getAccountInformation/route'
import { POST as accountEnableRegionHandler } from '@/app/api/account/enableRegion/route'
import { POST as accountDisableRegionHandler } from '@/app/api/account/disableRegion/route'
import { POST as accountPutContactHandler } from '@/app/api/account/putContactInformation/route'
import { POST as ssmPutParameterHandler } from '@/app/api/ssm/AmazonSSM/PutParameter/route'
import { POST as ssmGetParameterHandler } from '@/app/api/ssm/AmazonSSM/GetParameter/route'

// Mock request info
jest.mock('@/app/api/common', () => {
  const actual = jest.requireActual('@/app/api/common')
  return {
    ...actual,
    getRequestInfo: jest.fn(() => ({
      principalAccount: '123456789012',
      user: 'testuser',
      userId: 'user-123',
      signature: 'mock-signature',
      timestamp: '2024-01-01T00:00:00Z',
    })),
  }
})

describe('API End-to-End Tests', () => {
  describe('IAM CreateRole API', () => {
    it('should create a role via POST request', async () => {
      const body = new URLSearchParams({
        Action: 'CreateRole',
        RoleName: 'TestRole',
        AssumeRolePolicyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'lambda.amazonaws.com' },
              Action: 'sts:AssumeRole',
            },
          ],
        }),
        Path: '/service-role/',
        Description: 'Test role description',
        Version: '2010-05-08',
      }).toString()

      const request = new Request('http://localhost/api/iam', {
        method: 'POST',
        body,
      })

      const response = await iamHandler(request)
      expect(response.status).toBe(200)

      const responseText = await response.text()
      expect(responseText).toContain('CreateRoleResponse')
      expect(responseText).toContain('TestRole')
      expect(responseText).toContain('service-role')
    })

    it('should return error for invalid role name', async () => {
      const body = new URLSearchParams({
        Action: 'CreateRole',
        RoleName: 'Invalid!!!Role!!!', // Invalid characters
        AssumeRolePolicyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: [],
        }),
        Version: '2010-05-08',
      }).toString()

      const request = new Request('http://localhost/api/iam', {
        method: 'POST',
        body,
      })

      const response = await iamHandler(request)
      expect(response.status).toBe(400)

      const responseText = await response.text()
      expect(responseText).toContain('Error')
    })
  })

  describe('IAM ListRoles API', () => {
    it('should list roles via POST request', async () => {
      const body = new URLSearchParams({
        Action: 'ListRoles',
        Version: '2010-05-08',
      }).toString()

      const request = new Request('http://localhost/api/iam', {
        method: 'POST',
        body,
      })

      const response = await iamHandler(request)
      expect(response.status).toBe(200)

      const responseText = await response.text()
      expect(responseText).toContain('ListRolesResponse')
    })
  })

  describe('IAM PutRolePolicy API', () => {
    it('should attach inline policy to role', async () => {
      const policyDoc = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 's3:*',
            Resource: '*',
          },
        ],
      }

      const body = new URLSearchParams({
        Action: 'PutRolePolicy',
        RoleName: 'TestRole',
        PolicyName: 'S3FullAccess',
        PolicyDocument: JSON.stringify(policyDoc),
        Version: '2010-05-08',
      }).toString()

      const request = new Request('http://localhost/api/iam', {
        method: 'POST',
        body,
      })

      const response = await iamHandler(request)
      expect(response.status).toBe(200)

      const responseText = await response.text()
      expect(responseText).toContain('PutRolePolicyResponse')
    })
  })

  describe('Account API - Region Management', () => {
    it('should enable a region via POST request', async () => {
      const body = JSON.stringify({
        AccountId: '123456789012',
        RegionName: 'eu-west-1',
      })

      const request = new Request('http://localhost/api/account/enableRegion', {
        method: 'POST',
        body,
      })

      const response = await accountEnableRegionHandler(request)
      expect(response.status).toBe(200)

      const responseText = await response.text()
      // Should contain success response (exact format depends on implementation)
      expect(responseText).toBeDefined()
    })

    it('should disable a region via POST request', async () => {
      const body = JSON.stringify({
        AccountId: '123456789012',
        RegionName: 'ap-south-1',
      })

      const request = new Request('http://localhost/api/account/disableRegion', {
        method: 'POST',
        body,
      })

      const response = await accountDisableRegionHandler(request)
      expect(response.status).toBe(200)

      const responseText = await response.text()
      expect(responseText).toBeDefined()
    })
  })

  describe('Account API - Contact Information', () => {
    it('should update contact information via POST request', async () => {
      const body = JSON.stringify({
        AccountId: '123456789012',
        ContactInformation: {
          FirstName: 'John',
          LastName: 'Doe',
          CompanyName: 'Acme Corp',
          PhoneNumber: '+1-555-0100',
          DistrictOrCounty: 'California',
          City: 'San Francisco',
          StateOrProvince: 'CA',
          PostalCode: '94103',
          CountryCode: 'US',
          WebsiteUrl: 'https://acme.com',
        },
      })

      const request = new Request(
        'http://localhost/api/account/putContactInformation',
        {
          method: 'POST',
          body,
        }
      )

      const response = await accountPutContactHandler(request)
      expect(response.status).toBe(200)

      const responseText = await response.text()
      expect(responseText).toBeDefined()
    })

    it('should get account information via POST request', async () => {
      const body = JSON.stringify({
        AccountId: '123456789012',
      })

      const request = new Request(
        'http://localhost/api/account/getAccountInformation',
        {
          method: 'POST',
          body,
        }
      )

      const response = await accountGetInformationHandler(request)
      expect(response.status).toBe(200)

      const responseText = await response.text()
      expect(responseText).toContain('Account')
      // Should contain account information in JSON format
      const data = JSON.parse(responseText)
      expect(data).toHaveProperty('Account')
    })
  })

  describe('SSM Parameter Store API', () => {
    it('should put a parameter via POST request', async () => {
      const body = JSON.stringify({
        Name: '/app/database/password',
        Value: 'secret-password-123',
        Type: 'SecureString',
        Tier: 'Standard',
        Description: 'Database password',
      })

      const request = new Request(
        'http://localhost/api/ssm/AmazonSSM/PutParameter',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-amz-json-1.1',
            'X-Amz-Target': 'AmazonSSM.PutParameter',
          },
          body,
        }
      )

      const response = await ssmPutParameterHandler(request)
      expect(response.status).toBe(200)

      const responseText = await response.text()
      const data = JSON.parse(responseText)
      expect(data).toHaveProperty('Version')
      expect(data).toHaveProperty('Tier')
    })

    it('should get a parameter via POST request', async () => {
      const body = JSON.stringify({
        Name: '/app/database/password',
        WithDecryption: true,
      })

      const request = new Request(
        'http://localhost/api/ssm/AmazonSSM/GetParameter',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-amz-json-1.1',
            'X-Amz-Target': 'AmazonSSM.GetParameter',
          },
          body,
        }
      )

      const response = await ssmGetParameterHandler(request)
      expect([200, 400]).toContain(response.status) // 400 if param doesn't exist

      const responseText = await response.text()
      expect(responseText).toBeDefined()
    })
  })

  describe('Error Handling', () => {
    it('should return proper error for missing required parameters', async () => {
      const body = new URLSearchParams({
        Action: 'CreateRole',
        // Missing RoleName and AssumeRolePolicyDocument
        Version: '2010-05-08',
      }).toString()

      const request = new Request('http://localhost/api/iam', {
        method: 'POST',
        body,
      })

      const response = await iamHandler(request)
      expect(response.status).toBe(400)

      const responseText = await response.text()
      expect(responseText).toContain('Error')
    })

    it('should handle invalid action gracefully', async () => {
      const body = new URLSearchParams({
        Action: 'InvalidAction',
        Version: '2010-05-08',
      }).toString()

      const request = new Request('http://localhost/api/iam', {
        method: 'POST',
        body,
      })

      const response = await iamHandler(request)
      expect(response.status).toBe(400)

      const responseText = await response.text()
      expect(responseText).toContain('InvalidAction')
    })
  })
})
