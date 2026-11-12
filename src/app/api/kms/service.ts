import { AwsError } from "../common"
import { PARTITION } from '../data/common'
import { JsonProtocol } from "../protocols"
import { defineService, type RequestContext } from "../registry"
import {
  createKey, describeKey, listKeys, getKeyPolicy, putKeyPolicy,
  enableKeyRotation, disableKeyRotation, getKeyRotationStatus,
  scheduleKeyDeletion, cancelKeyDeletion, enableKey, disableKey,
  encrypt, decrypt, generateDataKey,
  type KeyMetadata,
} from "./storage"

const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY_ARN = /^arn:[^:]+:kms:[^:]*:(\d{12}):key\/([^/]+)$/

/**
 * Key ID resolution: accepts key ID (UUID) or key ARN, validates ownership
 * @param account Caller's account ID
 * @param params Request parameters (must contain KeyId)
 * @returns Normalized key UUID (without account/region prefix)
 * @throws ValidationException if KeyId is missing or malformed
 * @throws NotFoundException if key does not belong to caller's account
 */
function resolveKeyId({ account, params }: RequestContext): string {
  const raw = params.KeyId
  if (typeof raw !== 'string' || raw === '') {
    throw new AwsError('ValidationException', "1 validation error detected: Value null at 'keyId' failed to satisfy constraint: Member must not be null")
  }
  const arn = raw.match(KEY_ARN)
  const id = arn ? arn[2] : raw
  if ((arn && arn[1] !== account) || !KEY_ID.test(id)) {
    throw new AwsError('NotFoundException', `Invalid keyId '${raw}'`)
  }
  return id
}

/**
 * RESOURCE WRAPPER PATTERN (KMS-Specific)
 * 
 * Wraps KMS operations that work with specific key resources:
 * 1. Resolve KeyId (UUID or ARN format)
 * 2. Validate key exists and belongs to caller's account
 * 3. Execute operation with resolved key ID
 * 4. Transform storage errors to AWS-compatible error codes:
 *    - "Key not found" → NotFoundException
 *    - Other errors → KMSInvalidStateException
 * 
 * Resource validation ensures:
 * - Cross-account key access is denied
 * - Invalid key IDs are rejected early
 * - Consistent error messages
 * 
 * @param ctx Request context (account, params, etc.)
 * @param fn Operation function that uses the resolved key ID
 * @returns Result from operation function
 * @throws NotFoundException if key doesn't exist or belongs to different account
 * @throws KMSInvalidStateException for other operation errors
 */
function withKey<T>(ctx: RequestContext, fn: (keyId: string) => T): T {
  const keyId = resolveKeyId(ctx)
  try {
    return fn(keyId)
  } catch (e) {
    if (e instanceof AwsError) throw e
    const message = (e as Error)?.message ?? String(e)
    if (message.startsWith('Key not found')) {
      throw new AwsError('NotFoundException', `Key '${keyArn(ctx, keyId)}' does not exist`)
    }
    throw new AwsError('KMSInvalidStateException', message)
  }
}

const keyArn = ({ account, region }: RequestContext, keyId: string) =>
  `arn:${PARTITION}:kms:${region}:${account}:key/${keyId}`

const keyResource = (ctx: RequestContext) => {
  try {
    return [keyArn(ctx, resolveKeyId(ctx))]
  } catch {
    return ['*']
  }
}

const epochSeconds = (iso: string) => Date.parse(iso) / 1000

function keyMetadata(ctx: RequestContext, m: KeyMetadata) {
  return {
    AWSAccountId: ctx.account,
    KeyId: m.keyId,
    Arn: keyArn(ctx, m.keyId),
    CreationDate: epochSeconds(m.creationDate),
    Enabled: m.state === 'Enabled',
    Description: m.description ?? '',
    KeyUsage: 'ENCRYPT_DECRYPT',
    KeyState: m.state,
    ...(m.deletionDate ? { DeletionDate: epochSeconds(m.deletionDate) } : {}),
    Origin: 'AWS_KMS',
    KeyManager: 'CUSTOMER',
    CustomerMasterKeySpec: 'SYMMETRIC_DEFAULT',
    KeySpec: 'SYMMETRIC_DEFAULT',
    EncryptionAlgorithms: ['SYMMETRIC_DEFAULT'],
    MultiRegion: false,
  }
}

function parsePolicy(policy: unknown) {
  if (policy === undefined) return undefined
  try {
    return typeof policy === 'string' ? JSON.parse(policy) : policy
  } catch {
    throw new AwsError('MalformedPolicyDocumentException', 'The policy is not valid JSON.')
  }
}

const onKey = { resources: keyResource }

/**
 * Helper to convert AWS base64 blob parameters to Buffer
 * AWS JSON protocol sends binary data as base64 strings
 */
function blobToBuffer(blob: unknown): Buffer {
  if (!blob) throw new AwsError('ValidationException', 'Blob parameter is required')
  if (typeof blob === 'string') {
    try {
      return Buffer.from(blob, 'base64')
    } catch {
      throw new AwsError('ValidationException', 'Invalid base64 in blob parameter')
    }
  }
  if (Buffer.isBuffer(blob)) return blob
  throw new AwsError('ValidationException', 'Blob must be base64 string or Buffer')
}

/**
 * Helper to convert Buffer to base64 for AWS JSON response
 */
function bufferToBlob(buf: Buffer): string {
  return buf.toString('base64')
}

// AWS KMS over the JSON 1.1 protocol (X-Amz-Target: TrentService.<Operation>).
export const kms = defineService({
  iamPrefix: 'kms',
  protocol: new JsonProtocol('1.1'),
  operations: {
    CreateKey: ctx => {
      const { keyMetadata: m } = createKey(ctx.account, ctx.params.Description ?? '', parsePolicy(ctx.params.Policy))
      return { KeyMetadata: keyMetadata(ctx, m) }
    },
    ListKeys: ctx => ({
      Keys: listKeys(ctx.account).map(k => ({ KeyId: k.keyId, KeyArn: keyArn(ctx, k.keyId) })),
      Truncated: false,
    }),
    DescribeKey: { ...onKey, handler: ctx => withKey(ctx, id => ({ KeyMetadata: keyMetadata(ctx, describeKey(ctx.account, id)) })) },
    GetKeyPolicy: { ...onKey, handler: ctx => withKey(ctx, id => ({ Policy: JSON.stringify(getKeyPolicy(ctx.account, id)), PolicyName: 'default' })) },
    PutKeyPolicy: {
      ...onKey, handler: ctx => withKey(ctx, id => {
        const policy = parsePolicy(ctx.params.Policy)
        if (!policy) throw new AwsError('ValidationException', 'Policy is required')
        putKeyPolicy(ctx.account, id, policy)
        return {}
      })
    },
    EnableKeyRotation: { ...onKey, handler: ctx => withKey(ctx, id => { enableKeyRotation(ctx.account, id); return {} }) },
    DisableKeyRotation: { ...onKey, handler: ctx => withKey(ctx, id => { disableKeyRotation(ctx.account, id); return {} }) },
    GetKeyRotationStatus: {
      ...onKey, handler: ctx => withKey(ctx, id => ({
        KeyRotationEnabled: getKeyRotationStatus(ctx.account, id).keyRotationEnabled,
        KeyId: keyArn(ctx, id),
      }))
    },
    ScheduleKeyDeletion: {
      ...onKey, handler: ctx => withKey(ctx, id => {
        const days = ctx.params.PendingWindowInDays ?? 30
        scheduleKeyDeletion(ctx.account, id, days)
        const m = describeKey(ctx.account, id)
        return {
          KeyId: keyArn(ctx, id),
          DeletionDate: m.deletionDate ? epochSeconds(m.deletionDate) : undefined,
          KeyState: m.state,
          PendingWindowInDays: days,
        }
      })
    },
    CancelKeyDeletion: { ...onKey, handler: ctx => withKey(ctx, id => { cancelKeyDeletion(ctx.account, id); return { KeyId: keyArn(ctx, id) } }) },
    EnableKey: { ...onKey, handler: ctx => withKey(ctx, id => { enableKey(ctx.account, id); return {} }) },
    DisableKey: { ...onKey, handler: ctx => withKey(ctx, id => { disableKey(ctx.account, id); return {} }) },
    
    // Cryptographic operations
    Encrypt: {
      ...onKey,
      handler: ctx => {
        try {
          return withKey(ctx, id => {
            const plaintext = blobToBuffer(ctx.params.Plaintext)
            const encryptionContext = ctx.params.EncryptionContext as Record<string, string> | undefined
            const ciphertext = encrypt(ctx.account, id, plaintext, encryptionContext)
            return {
              CiphertextBlob: ciphertext,
              KeyId: keyArn(ctx, id),
            }
          })
        } catch (e) {
          const msg = (e as Error).message
          if (msg.includes('DisabledException')) throw new AwsError('DisabledException', msg)
          if (msg.includes('KMSInvalidStateException')) throw new AwsError('KMSInvalidStateException', msg)
          if (msg.includes('ValidationException')) throw new AwsError('ValidationException', msg)
          throw e
        }
      }
    },
    Decrypt: {
      handler: ctx => {
        try {
          const ciphertext = typeof ctx.params.CiphertextBlob === 'string' 
            ? ctx.params.CiphertextBlob 
            : Buffer.isBuffer(ctx.params.CiphertextBlob)
            ? ctx.params.CiphertextBlob.toString('base64')
            : String(ctx.params.CiphertextBlob)
          
          const encryptionContext = ctx.params.EncryptionContext as Record<string, string> | undefined
          const { plaintext, keyId } = decrypt(ctx.account, ciphertext, encryptionContext)
          
          return {
            Plaintext: bufferToBlob(plaintext),
            KeyId: keyArn(ctx, keyId),
          }
        } catch (e) {
          const msg = (e as Error).message
          if (msg.includes('DisabledException')) throw new AwsError('DisabledException', msg)
          if (msg.includes('KMSInvalidStateException')) throw new AwsError('KMSInvalidStateException', msg)
          if (msg.includes('InvalidCiphertextException')) throw new AwsError('InvalidCiphertextException', msg)
          if (msg.includes('ValidationException')) throw new AwsError('ValidationException', msg)
          throw e
        }
      },
      resources: keyResource,
    },
    GenerateDataKey: {
      ...onKey,
      handler: ctx => {
        try {
          return withKey(ctx, id => {
            const keySpec = ctx.params.KeySpec ?? 'AES_256'
            const numberOfBytes = ctx.params.NumberOfBytes ?? (keySpec === 'AES_256' ? 32 : 16)
            const encryptionContext = ctx.params.EncryptionContext as Record<string, string> | undefined
            
            const { plaintext, ciphertext } = generateDataKey(ctx.account, id, numberOfBytes, encryptionContext)
            return {
              Plaintext: plaintext,
              CiphertextBlob: ciphertext,
              KeyId: keyArn(ctx, id),
              KeySpec: keySpec,
            }
          })
        } catch (e) {
          const msg = (e as Error).message
          if (msg.includes('DisabledException')) throw new AwsError('DisabledException', msg)
          if (msg.includes('KMSInvalidStateException')) throw new AwsError('KMSInvalidStateException', msg)
          if (msg.includes('ValidationException')) throw new AwsError('ValidationException', msg)
          throw e
        }
      }
    },
  },
})
