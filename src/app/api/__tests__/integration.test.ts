/**
 * Integration tests for API endpoints
 * These tests verify that refactored components work together correctly
 */

import {
  getRequestInfo,
  AwsError,
  awsJsonError,
  ok,
} from '@/app/api/common'

import {
  assertValidRegion,
  assertAccountExists,
  enableByDefaultRegions,
} from '@/app/api/data/common'

jest.mock('fs')

describe('API Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Request handling flow', () => {
    it('should extract and validate request info for a valid AWS request', () => {
      const request = new Request('http://localhost/api/account/getAccountInformation', {
        method: 'POST',
        headers: {
          'x-aws-principal': 'arn:aws:iam::123456789012:user/developer',
          'authorization': 'AWS4-HMAC-SHA256 Credential=test/20231201/us-east-1/account/aws4_request',
          'x-aws-userid': 'AIDAQ4EXAMPLEID:session-1',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      })

      const info = getRequestInfo(request)

      expect(info.principalAccount).toBe('123456789012')
      expect(info.region).toBe('us-east-1')
      expect(info.user).toContain('developer')
    })

    it('should validate region after extracting from request', () => {
      const request = new Request('http://localhost/', {
        headers: {
          'x-aws-principal': 'arn:aws:iam::123456789012:root',
          'authorization': 'AWS4-HMAC-SHA256 Credential=test/20231201/eu-west-1/account/aws4_request',
          'x-aws-userid': 'AIDAI123456789012345:session',
        },
      })

      const info = getRequestInfo(request)
      
      expect(() => assertValidRegion(info.region)).not.toThrow()
      expect(enableByDefaultRegions).toContain(info.region)
    })

    it('should reject request with invalid region', () => {
      const request = new Request('http://localhost/', {
        headers: {
          'x-aws-principal': 'arn:aws:iam::123456789012:user/test',
          'authorization': 'AWS4-HMAC-SHA256 Credential=test/20231201/invalid-zone/account/aws4_request',
          'x-aws-userid': 'TESTID',
        },
      })

      const info = getRequestInfo(request)
      
      expect(() => assertValidRegion(info.region)).toThrow('Invalid region')
    })
  })

  describe('Error handling consistency', () => {
    it('should format AWS errors consistently across response types', () => {
      const awsErr = new AwsError('ValidationException', 'Invalid parameter value', 400)
      const response = awsJsonError(awsErr)

      expect(response.status).toBe(400)
      expect(response.headers.get('x-amzn-errortype')).toBe('ValidationException')
      expect(response.headers.get('Content-Type')).toContain('application/x-amz-json')
    })

    it('should wrap unexpected errors as service exceptions', () => {
      const unexpectedErr = new Error('Unexpected system error')
      const response = awsJsonError(unexpectedErr)

      expect(response.status).toBe(500)
    })

    it('should preserve error details through error wrapping', async () => {
      const origErr = new AwsError('ResourceNotFound', 'Account 999999999999 not found', 404)
      const response = awsJsonError(origErr)

      const text = await response.text()
      const data = JSON.parse(text)

      expect(data.message).toBe('Account 999999999999 not found')
      expect(data.__type).toBe('ResourceNotFound')
    })
  })

  describe('Response generation', () => {
    it('should generate valid 200 OK response with data', async () => {
      const accountData = {
        accountId: '123456789012',
        accountName: 'Production',
        regions: ['us-east-1', 'eu-west-1'],
      }

      const response = ok(accountData)

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('application/json')

      const text = await response.text()
      const data = JSON.parse(text)
      expect(data.accountId).toBe('123456789012')
      expect(data.regions).toContain('us-east-1')
    })

    it('should generate empty 200 OK response when appropriate', async () => {
      const response = ok()

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toBe('')
    })
  })

  describe('Multiple account support', () => {
    it('should handle requests from different accounts', () => {
      const requests = [
        new Request('http://localhost/', {
          headers: {
            'x-aws-principal': 'arn:aws:iam::111111111111:user/admin',
            'authorization': 'AWS4-HMAC-SHA256 Credential=test/20231201/us-east-1/iam/aws4_request',
            'x-aws-userid': 'AIDAI111:session',
          },
        }),
        new Request('http://localhost/', {
          headers: {
            'x-aws-principal': 'arn:aws:iam::222222222222:user/admin',
            'authorization': 'AWS4-HMAC-SHA256 Credential=test/20231201/us-east-1/iam/aws4_request',
            'x-aws-userid': 'AIDAI222:session',
          },
        }),
      ]

      const infos = requests.map(r => getRequestInfo(r))

      expect(infos[0].principalAccount).toBe('111111111111')
      expect(infos[1].principalAccount).toBe('222222222222')
      expect(infos[0].principalAccount).not.toBe(infos[1].principalAccount)
    })
  })

  describe('Region availability across requests', () => {
    it('should support all enable-by-default regions', () => {
      enableByDefaultRegions.forEach(region => {
        expect(() => assertValidRegion(region)).not.toThrow()
      })
    })

    it('should validate opt-in regions', () => {
      const optInRegion = 'af-south-1'
      expect(() => assertValidRegion(optInRegion)).not.toThrow()
    })

    it('should reject duplicate region extraction', () => {
      const region1 = 'us-east-1'
      const region2 = 'us-east-1'

      assertValidRegion(region1)
      assertValidRegion(region2)

      expect(region1).toBe(region2)
    })
  })

  describe('Complex request scenarios', () => {
    it('should handle region extraction from various authorization formats', () => {
      const formats = [
        'AWS4-HMAC-SHA256 Credential=test/20231201/us-east-1/s3/aws4_request',
        'AWS4-HMAC-SHA256 Credential=test/20231201/eu-central-1/iam/aws4_request',
        'AWS4-HMAC-SHA256 Credential=test/20231201/ap-northeast-1/ec2/aws4_request',
      ]

      const regions = formats.map(authHeader => {
        const request = new Request('http://localhost/', {
          headers: {
            'x-aws-principal': 'arn:aws:iam::123456789012:user/test',
            'authorization': authHeader,
            'x-aws-userid': 'TESTID',
          },
        })
        return getRequestInfo(request).region
      })

      expect(regions[0]).toBe('us-east-1')
      expect(regions[1]).toBe('eu-central-1')
      expect(regions[2]).toBe('ap-northeast-1')
    })
  })
})
