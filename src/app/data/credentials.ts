import { createHash, randomBytes } from "crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs"

// *****************************************************************************
// ***                                                                       ***
// *** Credentials                                                           ***
// ***                                                                       ***
// *** Bootstrap keys:  db/tokens.json                { keyId: { secret, role } }
// *** Session keys:    db/<account>/credentials.json { keyId: Credential }      ***
// ***                                                                       ***
// *****************************************************************************

const DB = 'db'

export interface Credential {
  secret: string
  principal: string
  userId: string
  sessionToken?: string
  expiration?: number
}

const UPPER_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function random(length: number, chars: string): string {
  return Array.from(randomBytes(length), b => chars[b % chars.length]).join('')
}

// Stable pseudo id for principals that have no stored id (e.g. the bootstrap key).
export function pseudoId(prefix: string, seed: string): string {
  const digest = createHash('sha256').update(seed).digest()
  return prefix + Array.from(digest.subarray(0, 17), b => UPPER_ALNUM[b % UPPER_ALNUM.length]).join('')
}

function readJson(fn: string): any {
  return existsSync(fn) ? JSON.parse(readFileSync(fn).toString()) : {}
}

const credentialsFile = (account: string) => `${DB}/${account}/credentials.json`

export function findCredential(keyId: string): Credential | undefined {
  const token = readJson(`${DB}/tokens.json`)[keyId]
  if (token) {
    return { secret: token.secret, principal: token.role, userId: pseudoId('AROA', token.role) }
  }
  if (!existsSync(DB)) {
    return undefined
  }
  for (const dir of readdirSync(DB)) {
    if (/^\d{12}$/.test(dir)) {
      const credential = readJson(credentialsFile(dir))[keyId]
      if (credential) {
        return credential
      }
    }
  }
  return undefined
}

export function issueSession(account: string, principal: string, userId: string, durationSeconds: number) {
  const keyId = 'ASIA' + random(16, UPPER_ALNUM)
  const credential: Credential = {
    secret: random(40, BASE64),
    principal,
    userId,
    sessionToken: random(356, BASE64),
    expiration: Date.now() + durationSeconds * 1000
  }
  const fn = credentialsFile(account)
  const stored: Record<string, Credential> = readJson(fn)
  for (const [id, c] of Object.entries(stored)) {
    if (c.expiration !== undefined && c.expiration < Date.now()) {
      delete stored[id]
    }
  }
  stored[keyId] = credential
  mkdirSync(`${DB}/${account}`, { recursive: true })
  writeFileSync(fn, JSON.stringify(stored, null, 2))
  return { keyId, ...credential }
}
