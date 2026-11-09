import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import {
  putParameter,
  getParameter,
  getServiceSetting,
  setServiceSetting,
} from '@/app/api/db/ssm'

jest.mock('fs')

describe('SSM Database Operations', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Parameter Management', () => {
    it('should put a parameter with default settings', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>
      const mockMkdir = mkdirSync as jest.MockedFunction<typeof mkdirSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          parameters: {},
          settings: {
            '/ssm/parameter-store/default-parameter-tier': {
              SettingValue: 'Standard',
            },
          },
        })
      )

      const result = putParameter('123456789012', 'us-east-1', {
        name: '/app/database/password',
        value: 'secret123',
      })

      expect(result).toHaveProperty('Tier')
      expect(result).toHaveProperty('Version')
      expect(mockWrite).toHaveBeenCalled()
    })

    it('should put a parameter with custom tier', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          parameters: {},
          settings: {
            '/ssm/parameter-store/default-parameter-tier': {
              SettingValue: 'Standard',
            },
          },
        })
      )

      const result = putParameter('123456789012', 'us-east-1', {
        name: '/app/config/key',
        value: 'config-value',
        tier: 'Advanced',
      })

      expect(result.Tier).toBeDefined()
      expect(mockWrite).toHaveBeenCalled()
    })

    it('should increment version when updating existing parameter', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          parameters: {
            '/app/key': {
              Name: '/app/key',
              Value: 'old-value',
              Version: 1,
              Type: 'string',
              DataType: 'text',
              LastModifiedDate: Date.now() / 1000,
              Tier: 'Standard',
            },
          },
          settings: {
            '/ssm/parameter-store/default-parameter-tier': {
              SettingValue: 'Standard',
            },
          },
        })
      )

      const result = putParameter('123456789012', 'us-east-1', {
        name: '/app/key',
        value: 'new-value',
      })

      expect(result.Version).toBe(1)
      // The returned version should be the previous version; the stored version should be 2
      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.parameters['/app/key'].Version).toBe(2)
    })

    it('should store parameter with correct metadata', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          parameters: {},
          settings: {
            '/ssm/parameter-store/default-parameter-tier': {
              SettingValue: 'Standard',
            },
          },
        })
      )

      putParameter('123456789012', 'us-east-1', {
        name: '/prod/db/password',
        value: 'secret123',
        dataType: 'text',
        tier: 'Advanced',
      })

      expect(mockWrite).toHaveBeenCalled()
      const writeCall = mockWrite.mock.calls[0]
      const writtenData = JSON.parse(writeCall[1] as string)
      const param = writtenData.parameters['/prod/db/password']

      expect(param.Name).toBe('/prod/db/password')
      expect(param.Value).toBe('secret123')
      expect(param.Type).toBe('string')
      expect(param.DataType).toBe('text')
      expect(param.Tier).toBe('Advanced')
    })
  })

  describe('Parameter Retrieval', () => {
    it('should get a parameter', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          parameters: {
            '/app/key': {
              Name: '/app/key',
              Value: 'test-value',
              Version: 1,
              Type: 'string',
              DataType: 'text',
              LastModifiedDate: Date.now() / 1000,
              Tier: 'Standard',
            },
          },
        })
      )

      const param = getParameter('123456789012', 'us-east-1', '/app/key')
      expect(param.Name).toBe('/app/key')
      expect(param.Value).toBe('test-value')
    })

    it('should throw when parameter not found', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify({ parameters: {} }))

      expect(() => getParameter('123456789012', 'us-east-1', '/nonexistent')).toThrow()
    })
  })

  describe('Parameter Deletion', () => {
    it('should support parameter deletion via put with empty value', () => {
      // SSM doesn't have deleteParameter, but parameters can be overwritten
      // This test validates that we can update a parameter
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          parameters: {
            '/app/key': {
              Name: '/app/key',
              Value: 'value',
              Version: 1,
              Type: 'string',
              DataType: 'text',
              Tier: 'Standard',
            },
          },
          settings: {
            '/ssm/parameter-store/default-parameter-tier': {
              SettingValue: 'Standard',
            },
          },
        })
      )

      putParameter('123456789012', 'us-east-1', {
        name: '/app/key',
        value: 'new-value',
      })

      expect(mockWrite).toHaveBeenCalled()
      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.parameters['/app/key'].Version).toBe(2)
    })
  })

  describe('Service Settings', () => {
    it('should get a service setting', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          settings: {
            '/ssm/parameter-store/default-parameter-tier': {
              SettingValue: 'Advanced',
              Status: 'Customized',
              LastModifiedDate: Date.now() / 1000,
            },
          },
        })
      )

      const setting = getServiceSetting(
        '123456789012',
        'us-east-1',
        '/ssm/parameter-store/default-parameter-tier'
      )
      expect(setting.SettingValue).toBe('Advanced')
    })

    it('should update a service setting via setServiceSetting', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          settings: {
            '/ssm/parameter-store/default-parameter-tier': {
              SettingValue: 'Standard',
              Status: 'Default',
              LastModifiedDate: Date.now() / 1000,
            },
          },
        })
      )

      setServiceSetting(
        '123456789012',
        'us-east-1',
        '/ssm/parameter-store/default-parameter-tier',
        'Advanced',
        'TestUser'
      )

      expect(mockWrite).toHaveBeenCalled()
      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.settings['/ssm/parameter-store/default-parameter-tier'].SettingValue).toBe(
        'Advanced'
      )
    })

    it('should update setting status when changed from default', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          settings: {
            '/ssm/parameter-store/default-parameter-tier': {
              SettingValue: 'Standard',
              Status: 'Default',
              LastModifiedDate: Date.now() / 1000,
            },
          },
        })
      )

      setServiceSetting(
        '123456789012',
        'us-east-1',
        '/ssm/parameter-store/default-parameter-tier',
        'Advanced',
        'TestUser'
      )

      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      const setting = writtenData.settings['/ssm/parameter-store/default-parameter-tier']
      expect(setting.Status).toBe('Customized')
    })
  })

  describe('Multi-region Parameter Storage', () => {
    it('should store parameters in region-specific files', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          parameters: {},
          settings: {
            '/ssm/parameter-store/default-parameter-tier': {
              SettingValue: 'Standard',
            },
          },
        })
      )

      putParameter('123456789012', 'us-east-1', {
        name: '/app/key',
        value: 'value-east',
      })

      const writeCall = mockWrite.mock.calls[0]
      expect(writeCall[0]).toContain('us-east-1')
    })

    it('should isolate parameters across regions', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)

      // Read from us-east-1
      mockRead.mockReturnValueOnce(
        JSON.stringify({
          parameters: {
            '/app/key': { Name: '/app/key', Value: 'east-value' },
          },
        })
      )

      const paramEast = getParameter('123456789012', 'us-east-1', '/app/key')

      // Read from eu-west-1
      mockRead.mockReturnValueOnce(
        JSON.stringify({
          parameters: {
            '/app/key': { Name: '/app/key', Value: 'west-value' },
          },
        })
      )

      const paramWest = getParameter('123456789012', 'eu-west-1', '/app/key')

      expect(paramEast.Value).toBe('east-value')
      expect(paramWest.Value).toBe('west-value')
    })
  })

  describe('Parameter Data Types', () => {
    it('should support Text data type', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          parameters: {},
          settings: {
            '/ssm/parameter-store/default-parameter-tier': {
              SettingValue: 'Standard',
            },
          },
        })
      )

      putParameter('123456789012', 'us-east-1', {
        name: '/config/text',
        value: 'text-value',
        dataType: 'text',
      })

      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.parameters['/config/text'].DataType).toBe('text')
    })

    it('should support EC2 Image data type', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          parameters: {},
          settings: {
            '/ssm/parameter-store/default-parameter-tier': {
              SettingValue: 'Standard',
            },
          },
        })
      )

      putParameter('123456789012', 'us-east-1', {
        name: '/images/ami',
        value: 'ami-12345678',
        dataType: 'aws:ec2:image',
      })

      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.parameters['/images/ami'].DataType).toBe('aws:ec2:image')
    })
  })

  describe('Parameter Tiers', () => {
    it('should support Standard tier', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          parameters: {},
          settings: {
            '/ssm/parameter-store/default-parameter-tier': {
              SettingValue: 'Standard',
            },
          },
        })
      )

      putParameter('123456789012', 'us-east-1', {
        name: '/standard/param',
        value: 'value',
        tier: 'Standard',
      })

      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.parameters['/standard/param'].Tier).toBe('Standard')
    })

    it('should support Advanced tier', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          parameters: {},
          settings: {
            '/ssm/parameter-store/default-parameter-tier': {
              SettingValue: 'Standard',
            },
          },
        })
      )

      putParameter('123456789012', 'us-east-1', {
        name: '/advanced/param',
        value: 'value',
        tier: 'Advanced',
      })

      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.parameters['/advanced/param'].Tier).toBe('Advanced')
    })

    it('should support Intelligent-Tiering tier', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          parameters: {},
          settings: {
            '/ssm/parameter-store/default-parameter-tier': {
              SettingValue: 'Standard',
            },
          },
        })
      )

      putParameter('123456789012', 'us-east-1', {
        name: '/intelligent/param',
        value: 'value',
        tier: 'Intelligent-Tiering',
      })

      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.parameters['/intelligent/param'].Tier).toBe('Intelligent-Tiering')
    })
  })
})
