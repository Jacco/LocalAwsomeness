import {
  createKey,
  describeKey,
  listKeys,
  getKeyPolicy,
  putKeyPolicy,
  rotateKey,
  enableKeyRotation,
  disableKeyRotation,
  getKeyRotationStatus,
  scheduleKeyDeletion,
  cancelKeyDeletion,
  enableKey,
  disableKey
} from './storage'

export type KmsAction =
  | 'CreateKey'
  | 'DescribeKey'
  | 'ListKeys'
  | 'GetKeyPolicy'
  | 'PutKeyPolicy'
  | 'RotateKey'
  | 'EnableKeyRotation'
  | 'DisableKeyRotation'
  | 'GetKeyRotationStatus'
  | 'ScheduleKeyDeletion'
  | 'CancelKeyDeletion'
  | 'EnableKey'
  | 'DisableKey'

export interface KmsRequest {
  action: KmsAction
  account: string
  // Common parameters
  keyId?: string
  description?: string
  policy?: any
  // Rotation
  pendingWindowInDays?: number
  // Response control
  limit?: number
  marker?: string
}

export interface KmsResponse {
  status: number
  body: any
}

/**
 * Handle KMS API operations.
 */
export function handleKmsOperation(request: KmsRequest): KmsResponse {
  const { action, account, keyId, description, policy, pendingWindowInDays } = request

  try {
    switch (action) {
      case 'CreateKey':
        return {
          status: 200,
          body: createKey(account, description || '', policy)
        }

      case 'DescribeKey': {
        if (!keyId) throw new Error('KeyId required')
        const metadata = describeKey(account, keyId)
        return {
          status: 200,
          body: { KeyMetadata: metadata }
        }
      }

      case 'ListKeys': {
        const keys = listKeys(account)
        return {
          status: 200,
          body: {
            Keys: keys.map((k) => ({
              KeyId: k.keyId,
              KeyArn: k.arn
            })),
            Truncated: false
          }
        }
      }

      case 'GetKeyPolicy': {
        if (!keyId) throw new Error('KeyId required')
        const keyPolicy = getKeyPolicy(account, keyId)
        return {
          status: 200,
          body: { Policy: JSON.stringify(keyPolicy) }
        }
      }

      case 'PutKeyPolicy': {
        if (!keyId) throw new Error('KeyId required')
        if (!policy) throw new Error('Policy required')
        putKeyPolicy(account, keyId, policy)
        return {
          status: 200,
          body: {}
        }
      }

      case 'RotateKey': {
        if (!keyId) throw new Error('KeyId required')
        const version = rotateKey(account, keyId)
        return {
          status: 200,
          body: { KeyId: keyId, VersionId: version.versionId }
        }
      }

      case 'EnableKeyRotation': {
        if (!keyId) throw new Error('KeyId required')
        enableKeyRotation(account, keyId)
        return {
          status: 200,
          body: {}
        }
      }

      case 'DisableKeyRotation': {
        if (!keyId) throw new Error('KeyId required')
        disableKeyRotation(account, keyId)
        return {
          status: 200,
          body: {}
        }
      }

      case 'GetKeyRotationStatus': {
        if (!keyId) throw new Error('KeyId required')
        const status = getKeyRotationStatus(account, keyId)
        return {
          status: 200,
          body: status
        }
      }

      case 'ScheduleKeyDeletion': {
        if (!keyId) throw new Error('KeyId required')
        scheduleKeyDeletion(account, keyId, pendingWindowInDays || 7)
        const metadata = describeKey(account, keyId)
        return {
          status: 200,
          body: { KeyId: keyId, DeletionDate: metadata.deletionDate }
        }
      }

      case 'CancelKeyDeletion': {
        if (!keyId) throw new Error('KeyId required')
        cancelKeyDeletion(account, keyId)
        return {
          status: 200,
          body: { KeyId: keyId }
        }
      }

      case 'EnableKey': {
        if (!keyId) throw new Error('KeyId required')
        enableKey(account, keyId)
        return {
          status: 200,
          body: {}
        }
      }

      case 'DisableKey': {
        if (!keyId) throw new Error('KeyId required')
        disableKey(account, keyId)
        return {
          status: 200,
          body: {}
        }
      }

      default:
        return {
          status: 400,
          body: { error: `Unknown action: ${action}` }
        }
    }
  } catch (error) {
    return {
      status: 400,
      body: {
        __type: 'InvalidKeyId.Exception',
        message: (error as any)?.message || String(error)
      }
    }
  }
}
