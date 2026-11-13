import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The credentials store uses the relative directory `db`: run in a temporary directory so the real db/ is not touched.
const cwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'jpk-credentials-'))
process.chdir(root)
mkdirSync('db')

/* eslint-disable @typescript-eslint/no-require-imports */
const { findCredential, issueSession } = require('@/app/api/data/credentials')

const A = '111111111111'
const B = '222222222222'
const stored = (account: string) =>
  existsSync(`db/${account}/credentials.json`) ? JSON.parse(readFileSync(`db/${account}/credentials.json`, 'utf8')) : {}
const session = (account: string, seconds = 900) =>
  issueSession(account, `arn:aws:sts::${account}:assumed-role/r/s`, 'AROAEXAMPLE:s', seconds)

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') })
  rmSync('db', { recursive: true, force: true })
  mkdirSync('db')
})
afterEach(() => jest.useRealTimers())
afterAll(() => {
  process.chdir(cwd)
  rmSync(root, { recursive: true, force: true })
})

describe('expired sessions', () => {
  it('are still returned when looked up, so the proxy can answer ExpiredToken', () => {
    const { keyId } = session(A)
    jest.advanceTimersByTime(901_000)
    const credential = findCredential(keyId)
    expect(credential?.expiration).toBeLessThan(Date.now())
    expect(stored(A)[keyId]).toBeDefined()
  })

  it('are removed from every account file on a lookup of another key', () => {
    const expiredA = session(A).keyId
    const expiredB = session(B).keyId
    jest.advanceTimersByTime(901_000)
    const live = session(A, 3600).keyId

    expect(findCredential(live)?.principal).toBe(`arn:aws:sts::${A}:assumed-role/r/s`)
    expect(Object.keys(stored(A))).toEqual([live])
    expect(stored(B)[expiredB]).toBeUndefined()
    expect(stored(A)[expiredA]).toBeUndefined()
  })

  it('are removed when a new session is issued for the account, and live ones are kept', () => {
    const expired = session(A, 900).keyId
    const alive = session(A, 3600).keyId
    jest.advanceTimersByTime(901_000)
    const fresh = session(A).keyId
    expect(Object.keys(stored(A)).sort()).toEqual([alive, fresh].sort())
    expect(stored(A)[expired]).toBeUndefined()
  })

  it('leave the file alone when nothing has expired', () => {
    const { keyId } = session(A)
    const before = readFileSync(`db/${A}/credentials.json`, 'utf8')
    expect(findCredential('ASIAUNKNOWN')).toBeUndefined()
    expect(findCredential(keyId)).toBeDefined()
    expect(readFileSync(`db/${A}/credentials.json`, 'utf8')).toBe(before)
  })
})
