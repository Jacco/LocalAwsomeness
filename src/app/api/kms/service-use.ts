import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { logCloudTrailEvent } from '../cloudtrail/cloudtrail'
import { AwsError } from '../common'

// KMS as used by a service for the data it stores (CloudFormation templates first; later SSM, Lambda, S3).
//
// Only AWS owned keys so far: a key that belongs to the service, not to the customer's account. It is never listed,
// described or governed by a key policy the customer sees, and AWS records no KMS events for it in the customer's
// CloudTrail. The simulator still records the calls, marked `simulated`, so they can be traced. The data itself stays
// plaintext (record-only): the service stores an EncryptionRecord next to it and decrypts the data key on every read,
// so a mismatched encryption context or a tampered record fails like envelope encryption would.

// The account the AWS owned keys live in, standing for the AWS service account that owns them in AWS.
export const AWS_OWNED_KEY_ACCOUNT = '000000000000'

export interface ServiceCaller {
  principal: string
  account: string
  region: string
}

export interface EncryptionRecord {
  kmsKeyId: string
  keyManager: 'AWS_OWNED'
  encryptionContext: Record<string, string>
  // The data key encrypted under the KMS key: base64 of nonce (12) + tag (16) + ciphertext.
  encryptedDataKey: string
}

interface OwnedKey {
  keyId: string
  material: string
  creationDate: string
}

// With the AWS side of the simulation (data/aws), but git-ignored: it holds key material.
function ownedKeyFile(service: string, region: string): string {
  const root = process.env.JPK_DB_ROOT || 'data'
  return join(root, 'aws', 'kms', region, `${service}.json`)
}

// The service's AWS owned key in the Region, created on first use.
function ownedKey(service: string, region: string): OwnedKey {
  const file = ownedKeyFile(service, region)
  try {
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf8'))
    }
    const key: OwnedKey = { keyId: randomUUID(), material: randomBytes(32).toString('base64'), creationDate: new Date().toISOString() }
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(key, null, 2))
    return key
  } catch (e) {
    throw new AwsError('KMSInternalException', `The AWS owned key of ${service} in ${region} is not available: ${(e as Error).message}`, 500)
  }
}

export function ownedKeyArn(region: string, keyId: string): string {
  return `arn:aws:kms:${region}:${AWS_OWNED_KEY_ACCOUNT}:key/${keyId}`
}

// The encryption context as additional authenticated data: key order does not matter, as in KMS.
function aad(context: Record<string, string>): Buffer {
  return Buffer.from(JSON.stringify(Object.keys(context).sort().map(k => [k, context[k]])))
}

function record(action: 'GenerateDataKey' | 'Decrypt', service: string, caller: ServiceCaller, keyArn: string, context: Record<string, string>, errorCode?: string, errorMessage?: string) {
  logCloudTrailEvent({
    timestamp: new Date().toISOString(),
    principal: caller.principal,
    service: 'kms',
    action,
    resource: keyArn,
    account: caller.account,
    region: caller.region,
    authorizationDecision: 'allow',
    parameters: {
      keyId: keyArn,
      encryptionContext: context,
      ...(action === 'GenerateDataKey' && { keySpec: 'AES_256' }),
      keyManager: 'AWS_OWNED',
      invokedBy: `${service}.amazonaws.com`,
    },
    simulated: true,
    ...(errorCode && { errorCode, errorMessage }),
  })
}

// GenerateDataKey by `service` for the caller, with the service's AWS owned key. The plaintext data key is not kept:
// in record-only mode nothing is encrypted with it.
export function generateDataKeyForService(service: string, caller: ServiceCaller, encryptionContext: Record<string, string>): EncryptionRecord {
  const key = ownedKey(service, caller.region)
  const keyArn = ownedKeyArn(caller.region, key.keyId)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key.material, 'base64'), nonce)
  cipher.setAAD(aad(encryptionContext))
  const encrypted = Buffer.concat([cipher.update(randomBytes(32)), cipher.final()])
  record('GenerateDataKey', service, caller, keyArn, encryptionContext)
  return {
    kmsKeyId: keyArn,
    keyManager: 'AWS_OWNED',
    encryptionContext,
    encryptedDataKey: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64'),
  }
}

// Decrypt by `service` for the caller of the data key in `stored`, with the encryption context the service expects.
// The key is the one the record names (its Region and key ID), not the one of the request's Region.
export function decryptForService(service: string, caller: ServiceCaller, stored: EncryptionRecord, encryptionContext: Record<string, string>): void {
  const keyArn = stored.kmsKeyId
  const fail = (code: string, message: string): never => {
    record('Decrypt', service, caller, keyArn, encryptionContext, code, message)
    throw new AwsError(code, message)
  }
  const arn = keyArn.match(/^arn:aws:kms:([a-z0-9-]+):(\d{12}):key\/([0-9a-f-]{36})$/)
  if (!arn || arn[2] !== AWS_OWNED_KEY_ACCOUNT) {
    fail('InvalidCiphertextException', `${keyArn} is not an AWS owned key of ${service}`)
  }
  const [, region, , keyId] = arn!
  // A lost key file is recreated on use (owned keys are git-ignored and not seeded), so data encrypted before then is
  // under a key that no longer exists: say so instead of reporting a bad ciphertext.
  const key = ownedKey(service, region)
  if (key.keyId !== keyId) {
    fail('NotFoundException', `The AWS owned key ${keyArn} of ${service} that encrypted this data was lost: ${ownedKeyFile(service, region)} now holds key ${key.keyId} (created ${key.creationDate}). The data cannot be decrypted; recreate it.`)
  }
  const blob = Buffer.from(stored.encryptedDataKey, 'base64')
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key.material, 'base64'), blob.subarray(0, 12))
    decipher.setAuthTag(blob.subarray(12, 28))
    decipher.setAAD(aad(encryptionContext))
    Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()])
  } catch {
    fail('InvalidCiphertextException', 'The ciphertext is invalid or the encryption context does not match the one it was encrypted with')
  }
  record('Decrypt', service, caller, keyArn, encryptionContext)
}
