import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { accountDirExists, listAccountDirs, read, remove, storePath, update, write } from '"@/app/data/store'

jest.mock('fs')

const mockExists = existsSync as jest.Mock
const mockRead = readFileSync as jest.Mock
const mockWrite = writeFileSync as jest.Mock
const mockRename = renameSync as jest.Mock
const mockMkdir = mkdirSync as jest.Mock

describe('store', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('storePath', () => {
    it('maps keys onto the db/ layout', () => {
      expect(storePath({ service: 'accounts' })).toBe('db/accounts.json')
      expect(storePath({ service: 'iam', account: '123456789012' })).toBe('db/123456789012/iam.json')
      expect(storePath({ service: 'ssm', account: '123456789012', region: 'eu-west-1' }))
        .toBe('db/123456789012/eu-west-1/ssm.json')
    })

    it('rejects a region without an account', () => {
      expect(() => storePath({ service: 'ssm', region: 'eu-west-1' })).toThrow('A region requires an account')
    })
  })

  describe('read', () => {
    it('returns the fallback when nothing is stored', () => {
      mockExists.mockReturnValue(false)
      expect(read({ service: 'iam', account: '1' }, { roles: {} })).toEqual({ roles: {} })
      expect(mockRead).not.toHaveBeenCalled()
    })

    it('parses the stored file', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify({ roles: { a: 1 } }))
      expect(read({ service: 'iam', account: '1' }, { roles: {} })).toEqual({ roles: { a: 1 } })
    })
  })

  describe('write', () => {
    it('writes a temp file next to the target and renames it into place', () => {
      write({ service: 'ssm', account: '1', region: 'eu-west-1' }, { a: 1 })

      expect(mockMkdir).toHaveBeenCalledWith('db/1/eu-west-1', { recursive: true })
      const tmp = mockWrite.mock.calls[0][0] as string
      expect(tmp).toMatch(/^db\/1\/eu-west-1\/ssm\.json\..+\.tmp$/)
      expect(JSON.parse(mockWrite.mock.calls[0][1])).toEqual({ a: 1 })
      expect(mockRename).toHaveBeenCalledWith(tmp, 'db/1/eu-west-1/ssm.json')
    })
  })

  describe('update', () => {
    it('applies the change to the current state and persists it', () => {
      mockExists.mockReturnValue(true)
      mockRead.mockReturnValue(JSON.stringify({ count: 1 }))

      const result = update<{ count: number }>({ service: 'x', account: '1' }, { count: 0 }, s => { s.count++ })

      expect(result).toEqual({ count: 2 })
      expect(JSON.parse(mockWrite.mock.calls[0][1])).toEqual({ count: 2 })
    })

    it('starts from the fallback when nothing is stored', () => {
      mockExists.mockReturnValue(false)
      update<{ count: number }>({ service: 'x', account: '1' }, { count: 0 }, s => { s.count++ })
      expect(JSON.parse(mockWrite.mock.calls[0][1])).toEqual({ count: 1 })
    })
  })

  it('remove deletes the file', () => {
    const { unlinkSync } = jest.requireMock('fs')
    remove({ service: 'organization', account: '1' })
    expect(unlinkSync).toHaveBeenCalledWith('db/1/organization.json')
  })

  it('accountDirExists checks the account directory', () => {
    mockExists.mockReturnValue(true)
    expect(accountDirExists('123')).toBe(true)
    expect(mockExists).toHaveBeenCalledWith('db/123')
  })

  it('listAccountDirs returns only directories', () => {
    const fs = jest.requireMock('fs')
    mockExists.mockReturnValue(true)
    fs.readdirSync.mockReturnValue(['accounts.json', '123'])
    fs.statSync.mockImplementation((p: string) => ({ isDirectory: () => p === 'db/123' }))
    expect(listAccountDirs()).toEqual(['123'])
  })
})
