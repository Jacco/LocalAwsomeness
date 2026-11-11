import { AwsError } from "../common"
import { PARTITION } from "../db/common"
import { JsonProtocol } from "../protocols"
import { defineService, type RequestContext } from "../registry"
import {
  createKey, describeKey, listKeys, getKeyPolicy, putKeyPolicy,
  enableKeyRotation, disableKeyRotation, getKeyRotationStatus,
  scheduleKeyDeletion, cancelKeyDeletion, enableKey, disableKey,
  type KeyMetadata,
} from "./storage"

const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY_ARN = /^arn:[^:]+:kms:[^:]*:(\d{12}):key\/([^/]+)$/

// Accepts a key id or key ARN of the caller's account; aliases are not supported (yet).
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
  },
})
