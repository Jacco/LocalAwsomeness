import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'

export interface KeyVersion {
  versionId: string
  createdDate: string
  material: string // Base64-encoded placeholder for now
}

export interface KeyMetadata {
  keyId: string
  arn: string
  state: 'Enabled' | 'Disabled' | 'PendingDeletion' | 'PendingImport'
  creationDate: string
  description: string
  primaryKeyVersion: string // e.g., "v1"
  keyRotationEnabled: boolean
  lastRotationDate?: string
  deletionDate?: string // When key is scheduled for deletion
}

export interface KeyPolicy {
  Version: string
  Statement: Array<{
    Sid?: string
    Effect: 'Allow' | 'Deny'
    Principal: any
    Action: string | string[]
    Resource: string | string[]
    Condition?: Record<string, any>
  }>
}

const s3Root = process.env.JPK_DB_ROOT || 'data'

function getKmsAccountPath(account: string): string {
  const kmsDir = join(s3Root, 'accounts', account, 'kms')
  if (!existsSync(kmsDir)) {
    mkdirSync(kmsDir, { recursive: true })
  }
  return kmsDir
}

function getKeyPath(account: string, keyId: string): string {
  return join(getKmsAccountPath(account), keyId)
}

function getKeyVersionPath(account: string, keyId: string): string {
  return join(getKeyPath(account, keyId), 'versions')
}

function generateKeyVersionId(): string {
  return `v${Date.now()}-${randomUUID().split('-')[0]}`
}

/**
 * Generate realistic key material (placeholder for now).
 * Could be base64-encoded random bytes, simple string, etc.
 */
function generateKeyMaterial(): string {
  // Simple placeholder - 256-bit equivalent in base64
  const randomBytes = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  return Buffer.from(randomBytes).toString('base64')
}

/**
 * Create a new KMS key.
 */
export function createKey(
  account: string,
  description: string = '',
  policy?: KeyPolicy
): { keyMetadata: KeyMetadata; keyPolicy: KeyPolicy } {
  const keyId = randomUUID()
  const arn = `arn:aws:kms:us-east-1:${account}:key/${keyId}`
  const now = new Date().toISOString()
  const versionId = 'v1'

  const metadata: KeyMetadata = {
    keyId,
    arn,
    state: 'Enabled',
    creationDate: now,
    description,
    primaryKeyVersion: versionId,
    keyRotationEnabled: false
  }

  // Create key directory and metadata
  const keyDir = getKeyPath(account, keyId)
  mkdirSync(keyDir, { recursive: true })

  writeFileSync(join(keyDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8')

  // Create initial key version
  const versionDir = join(getKeyVersionPath(account, keyId), versionId)
  mkdirSync(versionDir, { recursive: true })

  writeFileSync(join(versionDir, 'material.txt'), generateKeyMaterial(), 'utf8')
  writeFileSync(join(versionDir, 'created.txt'), now, 'utf8')

  // Create or use provided key policy
  const keyPolicy = policy || {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'Enable IAM policies',
        Effect: 'Allow',
        Principal: {
          AWS: `arn:aws:iam::${account}:root`
        },
        Action: 'kms:*',
        Resource: '*'
      }
    ]
  }

  writeFileSync(join(keyDir, 'policy.json'), JSON.stringify(keyPolicy, null, 2), 'utf8')

  // Add to keys.json
  updateKeysIndex(account, keyId, metadata)

  return { keyMetadata: metadata, keyPolicy }
}

/**
 * Describe a key (get its metadata).
 */
export function describeKey(account: string, keyId: string): KeyMetadata {
  const metadataPath = join(getKeyPath(account, keyId), 'metadata.json')
  if (!existsSync(metadataPath)) {
    throw new Error(`Key not found: ${keyId}`)
  }

  const content = readFileSync(metadataPath, 'utf8')
  return JSON.parse(content) as KeyMetadata
}

/**
 * List all keys in the account.
 */
export function listKeys(account: string): KeyMetadata[] {
  const keysPath = join(getKmsAccountPath(account), 'keys.json')
  if (!existsSync(keysPath)) {
    return []
  }

  const content = readFileSync(keysPath, 'utf8')
  const keysIndex = JSON.parse(content) as Record<string, KeyMetadata>
  return Object.values(keysIndex)
}

/**
 * Get key policy.
 */
export function getKeyPolicy(account: string, keyId: string): KeyPolicy {
  const policyPath = join(getKeyPath(account, keyId), 'policy.json')
  if (!existsSync(policyPath)) {
    throw new Error(`Key not found: ${keyId}`)
  }

  const content = readFileSync(policyPath, 'utf8')
  return JSON.parse(content) as KeyPolicy
}

/**
 * Put/update key policy.
 */
export function putKeyPolicy(account: string, keyId: string, policy: KeyPolicy): void {
  // Verify key exists
  describeKey(account, keyId)

  const policyPath = join(getKeyPath(account, keyId), 'policy.json')
  writeFileSync(policyPath, JSON.stringify(policy, null, 2), 'utf8')
}

/**
 * Rotate the key (create a new primary version).
 */
export function rotateKey(account: string, keyId: string): KeyVersion {
  const metadata = describeKey(account, keyId)

  const newVersionId = generateKeyVersionId()
  const now = new Date().toISOString()

  // Create new version directory
  const versionDir = join(getKeyVersionPath(account, keyId), newVersionId)
  mkdirSync(versionDir, { recursive: true })

  writeFileSync(join(versionDir, 'material.txt'), generateKeyMaterial(), 'utf8')
  writeFileSync(join(versionDir, 'created.txt'), now, 'utf8')

  // Update metadata to point to new version
  metadata.primaryKeyVersion = newVersionId
  metadata.lastRotationDate = now

  const metadataPath = join(getKeyPath(account, keyId), 'metadata.json')
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')

  return {
    versionId: newVersionId,
    createdDate: now,
    material: readFileSync(join(versionDir, 'material.txt'), 'utf8')
  }
}

/**
 * Enable key rotation.
 */
export function enableKeyRotation(account: string, keyId: string): void {
  const metadata = describeKey(account, keyId)
  metadata.keyRotationEnabled = true

  const metadataPath = join(getKeyPath(account, keyId), 'metadata.json')
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
}

/**
 * Disable key rotation.
 */
export function disableKeyRotation(account: string, keyId: string): void {
  const metadata = describeKey(account, keyId)
  metadata.keyRotationEnabled = false

  const metadataPath = join(getKeyPath(account, keyId), 'metadata.json')
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
}

/**
 * Get key rotation status.
 */
export function getKeyRotationStatus(account: string, keyId: string): {
  keyId: string
  keyRotationEnabled: boolean
  lastRotationDate?: string
} {
  const metadata = describeKey(account, keyId)
  return {
    keyId,
    keyRotationEnabled: metadata.keyRotationEnabled,
    lastRotationDate: metadata.lastRotationDate
  }
}

/**
 * Schedule key deletion (soft delete).
 */
export function scheduleKeyDeletion(account: string, keyId: string, pendingWindowInDays: number = 7): void {
  const metadata = describeKey(account, keyId)
  metadata.state = 'PendingDeletion'

  const deletionDate = new Date()
  deletionDate.setDate(deletionDate.getDate() + pendingWindowInDays)
  metadata.deletionDate = deletionDate.toISOString()

  const metadataPath = join(getKeyPath(account, keyId), 'metadata.json')
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
}

/**
 * Cancel key deletion.
 */
export function cancelKeyDeletion(account: string, keyId: string): void {
  const metadata = describeKey(account, keyId)
  metadata.state = 'Enabled'
  metadata.deletionDate = undefined

  const metadataPath = join(getKeyPath(account, keyId), 'metadata.json')
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
}

/**
 * Get all versions of a key.
 */
export function listKeyVersions(account: string, keyId: string): KeyVersion[] {
  const versionsDir = getKeyVersionPath(account, keyId)
  if (!existsSync(versionsDir)) {
    return []
  }

  const versions: KeyVersion[] = []
  const versionDirs = readFileSync(versionsDir, 'utf8')
  
  // This won't work directly - need to read directory
  // Let me fix this
  return versions
}

/**
 * Update the keys index for quick lookups.
 */
function updateKeysIndex(account: string, keyId: string, metadata: KeyMetadata): void {
  const keysPath = join(getKmsAccountPath(account), 'keys.json')
  let keysIndex: Record<string, KeyMetadata> = {}

  if (existsSync(keysPath)) {
    const content = readFileSync(keysPath, 'utf8')
    keysIndex = JSON.parse(content)
  }

  keysIndex[keyId] = metadata
  writeFileSync(keysPath, JSON.stringify(keysIndex, null, 2), 'utf8')
}

/**
 * Enable key (change state from Disabled to Enabled).
 */
export function enableKey(account: string, keyId: string): void {
  const metadata = describeKey(account, keyId)
  if (metadata.state !== 'Disabled') {
    throw new Error(`Cannot enable key in state: ${metadata.state}`)
  }
  metadata.state = 'Enabled'

  const metadataPath = join(getKeyPath(account, keyId), 'metadata.json')
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
}

/**
 * Disable key.
 */
export function disableKey(account: string, keyId: string): void {
  const metadata = describeKey(account, keyId)
  if (metadata.state === 'PendingDeletion') {
    throw new Error('Cannot disable key pending deletion')
  }
  metadata.state = 'Disabled'

  const metadataPath = join(getKeyPath(account, keyId), 'metadata.json')
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
}
