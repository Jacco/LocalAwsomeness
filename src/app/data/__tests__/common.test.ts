import { existsSync as existsSyncOrig } from 'fs'
import {
  enableByDefaultRegions,
  optinRegions,
  assertValidRegion,
  assertAccountExists,
  PARTITION,
} from '"@/app/data/common'

// Mock the fs module
jest.mock('fs')

describe('Database Common Utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Regions', () => {
    it('should have correct list of enable-by-default regions', () => {
      expect(enableByDefaultRegions).toContain('us-east-1')
      expect(enableByDefaultRegions).toContain('eu-west-1')
      expect(enableByDefaultRegions).toContain('ap-northeast-1')
      expect(enableByDefaultRegions.length).toBe(17)
    })

    it('should have correct list of opt-in regions', () => {
      expect(optinRegions).toContain('af-south-1')
      expect(optinRegions).toContain('ap-east-1')
      expect(optinRegions).toContain('me-south-1')
      expect(optinRegions.length).toBe(17)
    })

    it('should have no overlap between enableByDefault and optIn regions', () => {
      const overlap = enableByDefaultRegions.filter(r => optinRegions.includes(r))
      expect(overlap).toEqual([])
    })
  })

  describe('assertValidRegion', () => {
    it('should not throw for enable-by-default regions', () => {
      expect(() => assertValidRegion('us-east-1')).not.toThrow()
      expect(() => assertValidRegion('eu-central-1')).not.toThrow()
      expect(() => assertValidRegion('ap-northeast-1')).not.toThrow()
    })

    it('should not throw for opt-in regions', () => {
      expect(() => assertValidRegion('af-south-1')).not.toThrow()
      expect(() => assertValidRegion('ap-east-1')).not.toThrow()
      expect(() => assertValidRegion('me-south-1')).not.toThrow()
    })

    it('should throw for invalid regions', () => {
      expect(() => assertValidRegion('invalid-region')).toThrow('Invalid region invalid-region')
      expect(() => assertValidRegion('xx-test-1')).toThrow()
    })

    it('should be case-sensitive', () => {
      expect(() => assertValidRegion('US-EAST-1')).toThrow()
      expect(() => assertValidRegion('us-EAST-1')).toThrow()
    })
  })

  describe('assertAccountExists', () => {
    it('should not throw when account directory exists', () => {
      const mockExists = existsSyncOrig as jest.MockedFunction<typeof existsSyncOrig>
      mockExists.mockReturnValue(true)

      expect(() => assertAccountExists('123456789012')).not.toThrow()
      expect(mockExists).toHaveBeenCalledWith('db/123456789012')
    })

    it('should throw when account directory does not exist', () => {
      const mockExists = existsSyncOrig as jest.MockedFunction<typeof existsSyncOrig>
      mockExists.mockReturnValue(false)

      expect(() => assertAccountExists('999999999999')).toThrow('Account not found')
    })

    it('should check correct path for account', () => {
      const mockExists = existsSyncOrig as jest.MockedFunction<typeof existsSyncOrig>
      mockExists.mockReturnValue(true)

      assertAccountExists('890123456789')
      expect(mockExists).toHaveBeenCalledWith('db/890123456789')
    })
  })

  describe('PARTITION', () => {
    it('should be set to "aws"', () => {
      expect(PARTITION).toBe('aws')
    })
  })

  describe('Region list completeness', () => {
    it('should have all AWS standard regions in either list', () => {
      const allRegions = [...enableByDefaultRegions, ...optinRegions]
      const standardRegions = [
        'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
        'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
        'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
        'ap-south-1', 'ap-southeast-1', 'ap-southeast-2',
        'ca-central-1', 'sa-east-1',
      ]
      
      for (const region of standardRegions) {
        expect(allRegions).toContain(region)
      }
    })
  })
})
