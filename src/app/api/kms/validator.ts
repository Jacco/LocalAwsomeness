/**
 * KMS Permission Validator
 * 
 * Checks if a principal (IAM role/user) has permission to perform
 * specific KMS operations (GenerateDataKey, Decrypt, etc.)
 * 
 * Used by S3 to validate encryption/decryption permissions before
 * allowing PutObject or GetObject operations.
 */

import { getKeyPolicy, describeKey } from './storage'
import { namesPrincipal } from '../../auth/policy/principal'

export interface KmsPermissionCheck {
  allowed: boolean
  reason?: string
  keyArn?: string
}

/**
 * Check if a principal has permission to perform a KMS action
 * 
 * @param accountId - AWS account ID
 * @param principal - IAM principal ARN (e.g., arn:aws:iam::123456789012:role/lambda-executor)
 * @param keyId - KMS key ID (UUID)
 * @param action - KMS action to check (e.g., 'kms:GenerateDataKey', 'kms:Decrypt')
 * @returns Permission check result with allowed flag and reason
 * 
 * @example
 * const result = checkKmsPermission(
 *   '123456789012',
 *   'arn:aws:iam::123456789012:role/lambda-executor',
 *   '12345678-1234-1234-1234-123456789012',
 *   'kms:GenerateDataKey'
 * )
 * if (!result.allowed) {
 *   throw new Error(result.reason)
 * }
 */
export function checkKmsPermission(
  accountId: string,
  principal: string,
  keyId: string,
  action: string
): KmsPermissionCheck {
  try {
    // Validate inputs
    if (!accountId || !principal || !keyId || !action) {
      return {
        allowed: false,
        reason: 'Invalid KMS permission check parameters',
      }
    }

    // Ensure action is in kms: format
    const kmsAction = action.startsWith('kms:') ? action : `kms:${action}`

    // Get the key policy
    const policy = getKeyPolicy(accountId, keyId)
    if (!policy) {
      return {
        allowed: false,
        reason: `Key policy not found for keyId: ${keyId}`,
      }
    }

    // Get key metadata for ARN
    const keyMetadata = describeKey(accountId, keyId)
    if (!keyMetadata) {
      return {
        allowed: false,
        reason: `Key not found: ${keyId}`,
      }
    }

    // Parse policy (may be string or object)
    let policyObj: any
    if (typeof policy === 'string') {
      try {
        policyObj = JSON.parse(policy)
      } catch {
        return {
          allowed: false,
          reason: 'Invalid key policy format',
        }
      }
    } else {
      policyObj = policy
    }

    // Extract principal name/service from ARN
    // Format: arn:aws:iam::123456789012:role/lambda-executor
    //         arn:aws:iam::123456789012:user/alice
    //         s3.amazonaws.com (for services)
    const extractPrincipalName = (arn: string): string => {
      if (arn.includes(':')) {
        // IAM ARN - extract role or user name
        const parts = arn.split('/')
        return parts.length > 1 ? parts[parts.length - 1] : arn.split(':').pop() || ''
      }
      // Service principal
      return arn
    }

    const principalName = extractPrincipalName(principal)
    const principalService = principal.includes('.amazonaws.com') ? principal : ''

    // Check each statement in the policy
    if (!Array.isArray(policyObj.Statement)) {
      return {
        allowed: false,
        reason: 'Invalid policy structure: no Statement array',
        keyArn: keyMetadata.arn,
      }
    }

    for (const statement of policyObj.Statement) {
      // Only check Allow statements
      if (statement.Effect !== 'Allow') {
        continue
      }

      // Check if principal matches
      let principalMatches = false

      if (statement.Principal === '*') {
        principalMatches = true
      } else if (typeof statement.Principal === 'string') {
        principalMatches = statement.Principal === principal || statement.Principal === principalName
      } else if (typeof statement.Principal === 'object') {
        // Check AWS principals (array or string)
        const awsPrincipals = statement.Principal.AWS
          ? Array.isArray(statement.Principal.AWS)
            ? statement.Principal.AWS
            : [statement.Principal.AWS]
          : []

        // Check if our principal matches any AWS principal: the same ARN, or the role of an assumed-role session — in the
        // same account (a role of the same name in another account is someone else)
        principalMatches = awsPrincipals.some((p: string) => p === '*' || namesPrincipal(p, principal))

        // Check Service principals
        if (!principalMatches && principalService) {
          const servicePrincipals = statement.Principal.Service
            ? Array.isArray(statement.Principal.Service)
              ? statement.Principal.Service
              : [statement.Principal.Service]
            : []

          principalMatches = servicePrincipals.some((p: string) => p === principalService || p === '*')
        }
      }

      if (!principalMatches) {
        continue
      }

      // Check if action is allowed
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action || '']

      const actionMatches = actions.some((a: string) => {
        if (a === '*') return true
        if (a === kmsAction) return true
        // Handle wildcards like kms:*
        if (a.endsWith('*')) {
          const prefix = a.slice(0, -1)
          return kmsAction.startsWith(prefix)
        }
        return false
      })

      if (actionMatches) {
        return {
          allowed: true,
          keyArn: keyMetadata.arn,
        }
      }
    }

    // No matching Allow statement found
    return {
      allowed: false,
      reason: `Principal ${principal} is not authorized to perform ${kmsAction} on key ${keyId}`,
      keyArn: keyMetadata.arn,
    }
  } catch (error) {
    return {
      allowed: false,
      reason: `Error checking KMS permission: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Validate multiple KMS permissions in parallel
 * Returns false if any check fails
 */
export function checkAllKmsPermissions(
  accountId: string,
  principal: string,
  keyId: string,
  actions: string[]
): KmsPermissionCheck {
  for (const action of actions) {
    const result = checkKmsPermission(accountId, principal, keyId, action)
    if (!result.allowed) {
      return result
    }
  }

  return {
    allowed: true,
  }
}

/**
 * Generate AWS-compatible error message for KMS permission denial
 */
export function generateKmsAccessDeniedError(
  principal: string,
  action: string,
  keyArn: string
): { __type: string; message: string } {
  return {
    __type: 'AccessDenied',
    message: `User: ${principal} is not authorized to perform: ${action} on resource: ${keyArn}`,
  }
}
