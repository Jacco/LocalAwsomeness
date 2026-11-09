import { readFileSync, writeFileSync, existsSync } from 'fs'
import {
  enableRegion,
  disableRegion,
  listRegions,
  getRegion,
  putContactInformation,
  getContactInformation,
  putAlternateContact,
  getAlternateContact,
  deleteAlternateContact,
  putAccountName,
} from '@/app/api/db/account'

jest.mock('fs')

describe('Account Database Operations - Store/Retrieve Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Region Management - Enable/Disable', () => {
    it('should enable an opt-in region and persist to database', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify({}))

      enableRegion('123456789012', 'af-south-1')

      expect(mockWrite).toHaveBeenCalled()
      const writeCall = mockWrite.mock.calls[0]
      expect(writeCall[0]).toBe('db/123456789012/account.json')

      const writtenData = JSON.parse(writeCall[1] as string)
      expect(writtenData.regions['af-south-1']).toBe('ENABLED')
    })

    it('should not enable enable-by-default regions', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify({}))

      enableRegion('123456789012', 'us-east-1')

      // Should not write anything for enabled-by-default regions
      expect(mockWrite).not.toHaveBeenCalled()
    })

    it('should disable an opt-in region', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          regions: { 'af-south-1': 'ENABLED' },
        })
      )

      disableRegion('123456789012', 'af-south-1')

      expect(mockWrite).toHaveBeenCalled()
      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      // After disabling, regions should be undefined (removed)
      expect(writtenData.regions).toBeUndefined()
    })

    it('should throw when disabling enable-by-default region', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      mockExists.mockReturnValue(true)

      expect(() => disableRegion('123456789012', 'us-east-1')).toThrow(
        'Region us-east-1 cannot be disabled'
      )
    })

    it('should preserve existing regions when enabling a new one', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          regions: { 'ap-east-1': 'ENABLED' },
        })
      )

      enableRegion('123456789012', 'af-south-1')

      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.regions['ap-east-1']).toBe('ENABLED')
      expect(writtenData.regions['af-south-1']).toBe('ENABLED')
    })
  })

  describe('Region Listing', () => {
    it('should list all regions with correct status', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          regions: { 'af-south-1': 'ENABLED' },
        })
      )

      const regions = listRegions('123456789012')

      expect(regions['us-east-1']).toBe('ENABLED_BY_DEFAULT')
      expect(regions['af-south-1']).toBe('ENABLED')
      expect(regions['ap-east-1']).toBe('DISABLED')
    })

    it('should handle account with no region modifications', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify({}))

      const regions = listRegions('123456789012')

      // All default regions should be ENABLED_BY_DEFAULT
      expect(regions['us-east-1']).toBe('ENABLED_BY_DEFAULT')
      expect(regions['eu-west-1']).toBe('ENABLED_BY_DEFAULT')
      // All opt-in regions should be DISABLED
      expect(regions['af-south-1']).toBe('DISABLED')
    })
  })

  describe('Get Single Region Status', () => {
    it('should return ENABLED_BY_DEFAULT for default regions', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      mockExists.mockReturnValue(true)

      const status = getRegion('123456789012', 'us-east-1')

      expect(status).toBe('ENABLED_BY_DEFAULT')
    })

    it('should return ENABLED for enabled opt-in regions', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          regions: { 'af-south-1': 'ENABLED' },
        })
      )

      const status = getRegion('123456789012', 'af-south-1')

      expect(status).toBe('ENABLED')
    })

    it('should return DISABLED for disabled opt-in regions', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify({}))

      const status = getRegion('123456789012', 'af-south-1')

      expect(status).toBe('DISABLED')
    })
  })

  describe('Contact Information - Put/Get', () => {
    it('should store contact information', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify({}))

      const contactInfo = {
        Name: 'John Doe',
        Email: 'john@example.com',
        Phone: '+1-234-567-8900',
      }

      putContactInformation('123456789012', contactInfo)

      expect(mockWrite).toHaveBeenCalled()
      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.contact).toEqual(contactInfo)
    })

    it('should retrieve stored contact information', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      const contactInfo = {
        Name: 'Jane Smith',
        Email: 'jane@example.com',
        Phone: '+1-987-654-3210',
      }
      mockRead.mockReturnValue(
        JSON.stringify({
          contact: contactInfo,
        })
      )

      const retrieved = getContactInformation('123456789012')

      expect(retrieved).toEqual(contactInfo)
    })

    it('should return empty object when no contact information stored', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify({}))

      const retrieved = getContactInformation('123456789012')

      expect(retrieved).toEqual({})
    })

    it('should preserve contact info when saving other data', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      const existingContact = { Name: 'Existing' }
      mockRead.mockReturnValue(
        JSON.stringify({
          contact: existingContact,
        })
      )

      const newContact = { Name: 'New Contact', Email: 'new@example.com' }
      putContactInformation('123456789012', newContact)

      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.contact).toEqual(newContact)
    })
  })

  describe('Alternate Contact Management - Put/Get/Delete', () => {
    it('should store alternate contact by type', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify({}))

      const billingContact = {
        Name: 'Billing Manager',
        Email: 'billing@company.com',
      }

      putAlternateContact('123456789012', 'BILLING', billingContact)

      expect(mockWrite).toHaveBeenCalled()
      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData.alternate['BILLING']).toEqual(billingContact)
    })

    it('should retrieve alternate contact by type', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      const billingContact = { Name: 'Billing Manager' }
      mockRead.mockReturnValue(
        JSON.stringify({
          alternate: { BILLING: billingContact },
        })
      )

      const retrieved = getAlternateContact('123456789012', 'BILLING')

      expect(retrieved).toEqual(billingContact)
    })

    it('should support all three alternate contact types', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify({}))

      const contacts = {
        BILLING: { Name: 'Billing' },
        OPERATIONS: { Name: 'Operations' },
        SECURITY: { Name: 'Security' },
      }

      putAlternateContact('123456789012', 'BILLING', contacts.BILLING)
      mockRead.mockReturnValueOnce(
        JSON.stringify({ alternate: { BILLING: contacts.BILLING } })
      )
      putAlternateContact('123456789012', 'OPERATIONS', contacts.OPERATIONS)
      mockRead.mockReturnValueOnce(
        JSON.stringify({
          alternate: {
            BILLING: contacts.BILLING,
            OPERATIONS: contacts.OPERATIONS,
          },
        })
      )
      putAlternateContact('123456789012', 'SECURITY', contacts.SECURITY)

      expect(mockWrite.mock.calls.length).toBeGreaterThanOrEqual(1)
    })

    it('should delete alternate contact', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          alternate: { BILLING: { Name: 'Billing Manager' } },
        })
      )

      deleteAlternateContact('123456789012', 'BILLING')

      expect(mockWrite).toHaveBeenCalled()
      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      // After deleting all alternates, should be undefined
      expect(writtenData.alternate).toBeUndefined()
    })

    it('should return undefined for non-existent alternate contact', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify({}))

      const retrieved = getAlternateContact('123456789012', 'BILLING')

      expect(retrieved).toBeUndefined()
    })

    it('should reject invalid alternate contact type', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      mockExists.mockReturnValue(true)

      expect(() =>
        putAlternateContact('123456789012', 'INVALID' as any, {})
      ).toThrow()
    })
  })

  describe('Account Name Management', () => {
    it('should update account name in accounts.json', () => {
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      const accounts = [
        { id: '123456789012', name: 'Old Name' },
        { id: '999999999999', name: 'Other Account' },
      ]

      mockRead.mockReturnValue(JSON.stringify(accounts))

      putAccountName('123456789012', 'New Account Name')

      expect(mockWrite).toHaveBeenCalled()
      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData[0].name).toBe('New Account Name')
      expect(writtenData[1].name).toBe('Other Account')
    })

    it('should throw when account not found in accounts.json', () => {
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>

      const accounts = [{ id: '999999999999', name: 'Other Account' }]

      mockRead.mockReturnValue(JSON.stringify(accounts))

      expect(() => putAccountName('123456789012', 'New Name')).toThrow(
        'Account not found'
      )
    })

    it('should preserve other accounts when updating one', () => {
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      const accounts = [
        { id: '111111111111', name: 'Account 1' },
        { id: '222222222222', name: 'Account 2' },
        { id: '333333333333', name: 'Account 3' },
      ]

      mockRead.mockReturnValue(JSON.stringify(accounts))

      putAccountName('222222222222', 'Updated Account 2')

      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      expect(writtenData[0].id).toBe('111111111111')
      expect(writtenData[1].name).toBe('Updated Account 2')
      expect(writtenData[2].id).toBe('333333333333')
    })
  })

  describe('Data Persistence Scenarios', () => {
    it('should handle multiple operations on same account', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)

      // First operation: enable region
      mockRead.mockReturnValue(JSON.stringify({}))
      enableRegion('123456789012', 'af-south-1')

      // Second operation: add contact
      mockRead.mockReturnValue(
        JSON.stringify({
          regions: { 'af-south-1': 'ENABLED' },
        })
      )
      putContactInformation('123456789012', { Name: 'Admin' })

      // Verify both writes happened
      expect(mockWrite).toHaveBeenCalledTimes(2)
    })

    it('should cleanup empty region entries', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(
        JSON.stringify({
          regions: { 'af-south-1': 'ENABLED' },
        })
      )

      disableRegion('123456789012', 'af-south-1')

      const writtenData = JSON.parse(mockWrite.mock.calls[0][1] as string)
      // Should remove the regions key if empty
      expect(writtenData.regions).toBeUndefined()
    })

    it('should format JSON with proper indentation', () => {
      const mockExists = existsSync as jest.MockedFunction<typeof existsSync>
      const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>
      const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify({}))

      putContactInformation('123456789012', { Name: 'Test' })

      const writtenContent = mockWrite.mock.calls[0][1] as string
      // Should have proper indentation (2 spaces)
      expect(writtenContent).toContain('  ')
    })
  })
})
