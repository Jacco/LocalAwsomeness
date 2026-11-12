# KMS API Reference

**Service IAM Prefix**: `kms`  
**Protocol**: JSON 1.1 (X-Amz-Target: TrentService.Operation)  
**Documentation**: [AWS KMS API Reference](https://docs.aws.amazon.com/kms/latest/APIReference/)

---

## Overview

The KMS (Key Management Service) provides cryptographic key management and encryption. In this simulator, KMS handles:
- Cryptographic key creation and lifecycle management
- Key policies for permission control
- Key rotation scheduling
- Key state management (enabled, disabled, scheduled for deletion)
- Key metadata and ARN generation

**Key Integration**: KMS keys are region-specific and account-scoped. All operations validate the key ID/ARN belongs to the caller's account and the requested region.

---

## Implemented Operations

### Key Management

| # | Operation | Method | Target | IAM Action | Handler | Status |
|----|-----------|--------|--------|-----------|---------|--------|
| 1 | CreateKey | POST | TrentService.CreateKey | `kms:CreateKey` | `service.ts` | ✅ |
| 2 | DescribeKey | POST | TrentService.DescribeKey | `kms:DescribeKey` | `service.ts` | ✅ |
| 3 | ListKeys | POST | TrentService.ListKeys | `kms:ListKeys` | `service.ts` | ✅ |

### Key Policies

| # | Operation | Method | Target | IAM Action | Handler | Status |
|----|-----------|--------|--------|-----------|---------|--------|
| 4 | GetKeyPolicy | POST | TrentService.GetKeyPolicy | `kms:GetKeyPolicy` | `service.ts` | ✅ |
| 5 | PutKeyPolicy | POST | TrentService.PutKeyPolicy | `kms:PutKeyPolicy` | `service.ts` | ✅ |

### Key Rotation

| # | Operation | Method | Target | IAM Action | Handler | Status |
|----|-----------|--------|--------|-----------|---------|--------|
| 6 | EnableKeyRotation | POST | TrentService.EnableKeyRotation | `kms:EnableKeyRotation` | `service.ts` | ✅ |
| 7 | DisableKeyRotation | POST | TrentService.DisableKeyRotation | `kms:DisableKeyRotation` | `service.ts` | ✅ |
| 8 | GetKeyRotationStatus | POST | TrentService.GetKeyRotationStatus | `kms:GetKeyRotationStatus` | `service.ts` | ✅ |

### Key State

| # | Operation | Method | Target | IAM Action | Handler | Status |
|----|-----------|--------|--------|-----------|---------|--------|
| 9 | EnableKey | POST | TrentService.EnableKey | `kms:EnableKey` | `service.ts` | ✅ |
| 10 | DisableKey | POST | TrentService.DisableKey | `kms:DisableKey` | `service.ts` | ✅ |
| 11 | ScheduleKeyDeletion | POST | TrentService.ScheduleKeyDeletion | `kms:ScheduleKeyDeletion` | `service.ts` | ✅ |
| 12 | CancelKeyDeletion | POST | TrentService.CancelKeyDeletion | `kms:CancelKeyDeletion` | `service.ts` | ✅ |

**Total Implemented**: 12 operations

---

## Not Yet Implemented

| # | Operation | Reason | Priority |
|----|-----------|--------|----------|
| 1 | Encrypt | Data encryption | P1 | Core cryptographic operation |
| 2 | Decrypt | Data decryption | P1 | Core cryptographic operation |
| 3 | GenerateDataKey | Session keys | P1 | Generate ephemeral encryption keys |
| 4 | GenerateDataKeyWithoutPlaintext | Session keys | P1 | Generate encrypted-only session keys |
| 5 | ReEncrypt | Key rotation | P2 | Re-encrypt data with new CMK |
| 6 | GenerateMac | Authentication | P2 | Generate HMAC authentication codes |
| 7 | VerifyMac | Authentication | P2 | Verify HMAC authentication codes |
| 8 | Sign | Digital signatures | P2 | Sign data with asymmetric keys |
| 9 | Verify | Digital signatures | P2 | Verify digital signatures |
| 10 | GetPublicKey | Asymmetric keys | P2 | Export public key (asymmetric only) |
| 11 | CreateGrant | Fine-grained access | P1 | Delegation of key usage rights |
| 12 | RetireGrant | Fine-grained access | P1 | Retire delegation grant |
| 13 | ListGrants | Fine-grained access | P1 | List active grants for key |
| 14 | ReplicateKey | Multi-region | P2 | Replicate key to other region |
| 15 | ImportKeyMaterial | BYOK | P2 | Bring your own key material |

**Note**: 
- **Encryption Operations**: Core cryptographic operations (Encrypt, Decrypt, GenerateDataKey) are the most critical missing features (P1).
- **Grants**: Fine-grained access control separate from key policy (P1).
- **Asymmetric Support**: Current implementation is symmetric only. Asymmetric support (signing, verification) is P2.

---

## Common Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `AccessDenied` | 403 | Principal lacks required KMS permission |
| `ValidationException` | 400 | Invalid parameter or request format |
| `NotFoundException` | 404 | Key does not exist or is not found |
| `InvalidStateException` | 400 | Key is not in valid state for operation |
| `MalformedPolicyDocumentException` | 400 | Policy JSON is invalid |
| `LimitExceededException` | 400 | Rate limit or quota exceeded |
| `KMSInvalidStateException` | 400 | Key in invalid state (e.g., disabled) |
| `DisabledException` | 400 | Key is disabled |
| `PendingDeletionException` | 400 | Key is scheduled for deletion |

---

## Key ID Resolution

### Supported Key Identifiers
KMS accepts keys identified by:

1. **Key ID** (UUID format): `12345678-1234-1234-1234-123456789012`
2. **Key ARN**: `arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012`

### NOT Supported
- **Key Aliases**: `alias/my-key` (P2 for future implementation)
- **Cross-Account Keys**: All keys must belong to the caller's account

---

## Key Policies

### Default Policy
When a key is created without an explicit policy, a default policy is generated:
```json
{
  "Sid": "Enable IAM Root Permissions",
  "Effect": "Allow",
  "Principal": {
    "AWS": "arn:aws:iam::ACCOUNT:root"
  },
  "Action": "kms:*",
  "Resource": "*"
}
```

### Custom Policy
Example policy allowing specific principals to use the key:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Enable use of the key for encryption",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::ACCOUNT:role/my-role"
      },
      "Action": [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:GenerateDataKey"
      ],
      "Resource": "*"
    }
  ]
}
```

---

## Implementation Details

### Handler Organization
```
src/app/api/kms/
├─ service.ts              (defineService + operation registry)
├─ route.ts                (Next.js API route handler)
├─ storage.ts              (Key storage and lifecycle)
├─ validator.ts            (Input validation)
├─ TrentService/
│  └─ [action]/route.ts    (Dynamic operation routing)
```

### State Management
- **Storage**: `src/app/api/data/kms/` (keys per account, region-specific)
- **Key Metadata**: Tracks creation date, description, rotation status, state
- **Deletion Scheduling**: Keys can be scheduled for deletion with pending window (7-30 days)
- **Key State Values**: `Enabled`, `Disabled`, `PendingDeletion`, `Unavailable`

### Key Validation Pattern
```typescript
// From service.ts - withKey() wrapper
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
```

### Operation Registration Pattern
```typescript
export const kms = defineService({
  iamPrefix: 'kms',
  protocol: new JsonProtocol('1.1'),
  operations: {
    CreateKey: ctx => { /* implementation */ },
    DescribeKey: { 
      resources: keyResource, 
      handler: ctx => withKey(ctx, id => { /* impl */ }) 
    },
    // ... more operations
  },
})
```

---

## Testing

### Unit Tests
Location: `src/app/api/__tests__/kms.test.ts`

Test coverage includes:
- Key creation and lifecycle
- Key policy management
- Key state transitions (enabled → disabled → pending deletion)
- Key rotation configuration
- Error handling for invalid key IDs
- Cross-account access denial

Run tests:
```bash
npm test -- kms.test.ts
```

### Integration Tests (Terraform)
Location: `tests/terraform/services/kms.tf`

Tests end-to-end KMS operations:
```bash
cd tests/terraform
terraform apply -target=module.kms_tests
```

---

## Examples

### Create a Key
```bash
curl -X POST http://localhost:3000/api/kms/TrentService/CreateKey \
  -H "X-Amz-Target: TrentService.CreateKey" \
  -H "Content-Type: application/x-amz-json-1.1" \
  -d '{
    "Description": "My encryption key"
  }'

# Response
{
  "KeyMetadata": {
    "AWSAccountId": "123456789012",
    "KeyId": "12345678-1234-1234-1234-123456789012",
    "Arn": "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
    "CreationDate": 1731403480.123,
    "Enabled": true,
    "Description": "My encryption key",
    "KeyUsage": "ENCRYPT_DECRYPT",
    "KeyState": "Enabled",
    "Origin": "AWS_KMS",
    "KeyManager": "CUSTOMER",
    "CustomerMasterKeySpec": "SYMMETRIC_DEFAULT",
    "KeySpec": "SYMMETRIC_DEFAULT",
    "EncryptionAlgorithms": ["SYMMETRIC_DEFAULT"],
    "MultiRegion": false
  }
}
```

### Describe Key
```bash
curl -X POST http://localhost:3000/api/kms/TrentService/DescribeKey \
  -H "X-Amz-Target: TrentService.DescribeKey" \
  -H "Content-Type: application/x-amz-json-1.1" \
  -d '{
    "KeyId": "12345678-1234-1234-1234-123456789012"
  }'
```

### Set Key Policy
```bash
curl -X POST http://localhost:3000/api/kms/TrentService/PutKeyPolicy \
  -H "X-Amz-Target: TrentService.PutKeyPolicy" \
  -H "Content-Type: application/x-amz-json-1.1" \
  -d '{
    "KeyId": "12345678-1234-1234-1234-123456789012",
    "PolicyName": "default",
    "Policy": "{\"Version\": \"2012-10-17\", \"Statement\": [...]}"
  }'
```

### Schedule Key Deletion
```bash
curl -X POST http://localhost:3000/api/kms/TrentService/ScheduleKeyDeletion \
  -H "X-Amz-Target: TrentService.ScheduleKeyDeletion" \
  -H "Content-Type: application/x-amz-json-1.1" \
  -d '{
    "KeyId": "12345678-1234-1234-1234-123456789012",
    "PendingWindowInDays": 7
  }'
```

---

## Related Services

- **Authorization**: `src/app/auth/policy/` (evaluates key policies)
- **Data Layer**: `src/app/api/data/kms/` (state storage per account/region)

---

## Recent Changes

### Phase 2 Standardization (In Progress)
- Creating uniform README documentation
- Standardizing operation definitions
- Planning encryption operation implementation

---

## Known Limitations

1. **No Encryption Operations**: Core Encrypt/Decrypt not yet implemented (P1)
2. **No Grants**: Fine-grained access delegation not implemented (P1)
3. **No Aliases**: Key aliasing not supported (P2)
4. **Symmetric Only**: No asymmetric key support (P2)
5. **Single Region**: No multi-region replication (P2)

---

## Next Steps

1. Implement encryption operations (Encrypt, Decrypt, GenerateDataKey)
2. Add grants support for fine-grained access control
3. Implement key aliases for easier reference
4. Add multi-region key replication

---

## Questions?

Check `/docs/REFACTORING_READY_TO_START.md` for broader context or review test files for usage examples.
