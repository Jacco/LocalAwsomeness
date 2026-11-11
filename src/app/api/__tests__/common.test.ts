import {
  getRequestInfo,
  ok,
  okxml,
  AwsError,
  awsJson,
  awsJsonError,
  generateIamId,
} from '@/app/api/common'

describe('API Common Utilities', () => {
  describe('getRequestInfo', () => {
    it('should extract principal account from x-aws-principal header', () => {
      const request = new Request('http://localhost/', {
        headers: {
          'x-aws-principal': 'arn:aws:iam::123456789012:user/testuser',
          'authorization': 'AWS4-HMAC-SHA256 Credential=test/20231201/us-east-1/sts/aws4_request',
          'x-aws-userid': 'AIDAQ4EXAMPLEID:session',
        },
      })

      const info = getRequestInfo(request)

      expect(info.principalAccount).toBe('123456789012')
      expect(info.user).toBe('arn:aws:iam::123456789012:user/testuser')
      expect(info.userId).toBe('AIDAQ4EXAMPLEID:session')
      expect(info.region).toBe('us-east-1')
    })

    it('should handle different regions from authorization header', () => {
      const request = new Request('http://localhost/', {
        headers: {
          'x-aws-principal': 'arn:aws:iam::999999999999:user/admin',
          'authorization': 'AWS4-HMAC-SHA256 Credential=test/20231201/eu-central-1/s3/aws4_request',
          'x-aws-userid': 'TESTID',
        },
      })

      const info = getRequestInfo(request)

      expect(info.region).toBe('eu-central-1')
    })

    it('should read region from the URL when the authorization header is unavailable', () => {
      const request = new Request('http://localhost/api/s3/?region=eu-central-1', {
        headers: {
          'x-aws-principal': 'arn:aws:iam::123456789012:user/testuser',
          'x-aws-userid': 'AIDAQ4EXAMPLEID:session',
        },
      })

      expect(getRequestInfo(request).region).toBe('eu-central-1')
    })
  })

  describe('ok', () => {
    it('should return 200 OK response with JSON content type', () => {
      const response = ok({ message: 'success' })

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('application/json')
    })

    it('should serialize object to JSON', async () => {
      const testObj = { key: 'value', nested: { prop: 123 } }
      const response = ok(testObj)

      const text = await response.text()
      expect(text).toContain('key')
      expect(text).toContain('value')
    })

    it('should return empty response when no object provided', async () => {
      const response = ok()

      const text = await response.text()
      expect(text).toBe('')
    })

    it('should return empty response when undefined provided', async () => {
      const response = ok(undefined)

      const text = await response.text()
      expect(text).toBe('')
    })
  })

  describe('okxml', () => {
    it('should return 200 OK response with XML content type', () => {
      const response = okxml('<root><item>test</item></root>')

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('application/xml')
    })

    it('should return provided XML', async () => {
      const xml = '<root><item>value</item></root>'
      const response = okxml(xml)

      const text = await response.text()
      expect(text).toBe(xml)
    })

    it('should return empty response when no XML provided', async () => {
      const response = okxml()

      const text = await response.text()
      expect(text).toBe('')
    })
  })

  describe('AwsError', () => {
    it('should create error with type, message, and status', () => {
      const error = new AwsError('InvalidInput', 'Invalid parameter', 400)

      expect(error.type).toBe('InvalidInput')
      expect(error.message).toBe('Invalid parameter')
      expect(error.status).toBe(400)
      expect(error.name).toBe('InvalidInput')
    })

    it('should default status to 400', () => {
      const error = new AwsError('ValidationException', 'Validation failed')

      expect(error.status).toBe(400)
    })

    it('should allow custom status codes', () => {
      const error = new AwsError('AccessDenied', 'Not authorized', 403)

      expect(error.status).toBe(403)
    })
  })

  describe('awsJson', () => {
    it('should return 200 OK with AWS JSON v1.1 content type', () => {
      const response = awsJson({ data: 'test' })

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('application/x-amz-json-1.1')
    })

    it('should serialize object to JSON', async () => {
      const response = awsJson({ Users: [] })

      const text = await response.text()
      const parsed = JSON.parse(text)
      expect(parsed.Users).toEqual([])
    })

    it('should support v1.0 format', () => {
      const response = awsJson({ data: 'test' }, '1.0')

      expect(response.headers.get('Content-Type')).toBe('application/x-amz-json-1.0')
    })

    it('should return empty object when no argument provided', async () => {
      const response = awsJson()

      const text = await response.text()
      const parsed = JSON.parse(text)
      expect(parsed).toEqual({})
    })
  })

  describe('awsJsonError', () => {
    it('should format AwsError correctly', () => {
      const awsErr = new AwsError('InvalidParameter', 'Invalid value', 400)
      const response = awsJsonError(awsErr)

      expect(response.status).toBe(400)
      expect(response.headers.get('x-amzn-errortype')).toBe('InvalidParameter')
    })

    it('should set error type in response body', async () => {
      const awsErr = new AwsError('ValidationException', 'Invalid input')
      const response = awsJsonError(awsErr)

      const text = await response.text()
      const data = JSON.parse(text)
      expect(data.__type).toBe('ValidationException')
      expect(data.message).toBe('Invalid input')
    })

    it('should wrap generic errors as ServiceException', async () => {
      const genericErr = new Error('Something went wrong')
      const response = awsJsonError(genericErr)

      expect(response.status).toBe(500)
      const text = await response.text()
      const data = JSON.parse(text)
      expect(data.__type).toBe('ServiceException')
    })

    it('should support v1.0 format', () => {
      const awsErr = new AwsError('TestError', 'Test message')
      const response = awsJsonError(awsErr, '1.0')

      expect(response.headers.get('Content-Type')).toBe('application/x-amz-json-1.0')
    })
  })

  describe('generateIamId', () => {
    it('should generate ID with correct prefix', () => {
      const id = generateIamId('AIDAI', 21)

      expect(id).toMatch(/^AIDAI[A-Z0-9]+$/)
      expect(id.length).toBe(21)
    })

    it('should use default length of 21', () => {
      const id = generateIamId('AIDA')

      expect(id.length).toBe(21)
    })

    it('should use only alphabet characters', () => {
      const id = generateIamId('TEST', 10)

      expect(id).toMatch(/^TEST[A-Z0-9]{6}$/)
    })

    it('should generate different IDs each time', () => {
      const id1 = generateIamId('ID', 15)
      const id2 = generateIamId('ID', 15)

      expect(id1).not.toBe(id2)
    })

    it('should respect custom length parameter', () => {
      const id = generateIamId('ROLE', 30)

      expect(id.length).toBe(30)
      expect(id.startsWith('ROLE')).toBe(true)
    })
  })
})
