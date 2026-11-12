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

# KMS API Reference

**Service IAM Prefix**: `kms`  
**Protocol**: JSON 1.1 (X-Amz-Target: TrentService.Operation)  
**Documentation**: [AWS KMS API Reference](https://docs.aws.amazon.com/kms/latest/APIReference/)

---

## Overview

The KMS (Key Management Service) provides cryptographic key management and encryption. In this simulator, KMS handles:
- Cryptographic key creation and lifecycle management
- **Key encryption and decryption** (NEW in Phase 2.2)
- Key policies for permission control
- Key rotation scheduling
- Key state management (enabled, disabled, scheduled for deletion)
- Key metadata and ARN generation

**Key Integration**: KMS keys are region-specific and account-scoped. All operations validate the key ID/ARN belongs to the caller's account and the requested region.

---

## Implemented Operations

### Cryptographic Operations (NEW - Phase 2.2)

| # | Operation | Method | Target | IAM Action | Handler | Status |
|----|-----------|--------|--------|-----------|---------|--------|
| 1 | **Encrypt** | POST | TrentService.Encrypt | `kms:Encrypt` | `service.ts` | ✅ **NEW** |
| 2 | **Decrypt** | POST | TrentService.Decrypt | `kms:Decrypt` | `service.ts` | ✅ **NEW** |
| 3 | **GenerateDataKey** | POST | TrentService.GenerateDataKey | `kms:GenerateDataKey` | `service.ts` | ✅ **NEW** |

**Encrypt Operation Details**:
- Encrypts plaintext data with a KMS key
- Uses AES-256-GCM (authenticated encryption)
- Supports optional `EncryptionContext` for additional authentication data
- Plaintext size: 1-4096 bytes
- Returns opaque ciphertext blob containing key ID
- Validates key is Enabled (not Disabled or PendingDeletion)

**Decrypt Operation Details**:
- Decrypts ciphertext blob produced by Encrypt
- Requires matching EncryptionContext if one was used during encryption
- Returns original plaintext
- Validates authentication tag (prevents tampered data)
- Returns KeyId (ARN) of key used for encryption

**GenerateDataKey Operation Details**:
- Generates a random data encryption key
- Returns both plaintext (for immediate use) and encrypted versions
- Used for envelope encryption pattern
- Supports optional EncryptionContext
- Default key size: 256 bits (AES-256)
- Perfect for: encrypting large files, S3 server-side encryption, database encryption

### Key Management

| # | Operation | Method | Target | IAM Action | Handler | Status |
|----|-----------|--------|--------|-----------|---------|--------|
| 4 | CreateKey | POST | TrentService.CreateKey | `kms:CreateKey` | `service.ts` | ✅ |
| 5 | DescribeKey | POST | TrentService.DescribeKey | `kms:DescribeKey` | `service.ts` | ✅ |
| 6 | ListKeys | POST | TrentService.ListKeys | `kms:ListKeys` | `service.ts` | ✅ |

### Key Policies

| # | Operation | Method | Target | IAM Action | Handler | Status |
|----|-----------|--------|--------|-----------|---------|--------|
| 7 | GetKeyPolicy | POST | TrentService.GetKeyPolicy | `kms:GetKeyPolicy` | `service.ts` | ✅ |
| 8 | PutKeyPolicy | POST | TrentService.PutKeyPolicy | `kms:PutKeyPolicy` | `service.ts` | ✅ |

### Key Rotation

| # | Operation | Method | Target | IAM Action | Handler | Status |
|----|-----------|--------|--------|-----------|---------|--------|
| 9 | EnableKeyRotation | POST | TrentService.EnableKeyRotation | `kms:EnableKeyRotation` | `service.ts` | ✅ |
| 10 | DisableKeyRotation | POST | TrentService.DisableKeyRotation | `kms:DisableKeyRotation` | `service.ts` | ✅ |
| 11 | GetKeyRotationStatus | POST | TrentService.GetKeyRotationStatus | `kms:GetKeyRotationStatus` | `service.ts` | ✅ |

### Key State

| # | Operation | Method | Target | IAM Action | Handler | Status |
|----|-----------|--------|--------|-----------|---------|--------|
| 12 | EnableKey | POST | TrentService.EnableKey | `kms:EnableKey` | `service.ts` | ✅ |
| 13 | DisableKey | POST | TrentService.DisableKey | `kms:DisableKey` | `service.ts` | ✅ |
| 14 | ScheduleKeyDeletion | POST | TrentService.ScheduleKeyDeletion | `kms:ScheduleKeyDeletion` | `service.ts` | ✅ |
| 15 | CancelKeyDeletion | POST | TrentService.CancelKeyDeletion | `kms:CancelKeyDeletion` | `service.ts` | ✅ |

**Total Implemented**: 15 operations (up from 12)

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
| `InvalidCiphertextException` | 400 | Ciphertext authentication tag verification failed |

---

## Cryptographic Operations (Phase 2.2)

### Encryption Implementation Details

This simulator uses **AES-256 in GCM (Galois/Counter Mode)** for all KMS encryption:
- **Algorithm**: AES-256-GCM
- **Key Size**: 256 bits (32 bytes)
- **IV (Nonce)**: 12 random bytes (96 bits)
- **Authentication Tag**: 16 bytes (128 bits)
- **Overhead**: ~64 bytes total
- **Security**: Provides both confidentiality AND authentication

**Ciphertext Blob Format**:
```
[KeyID (36 bytes)][IV (12 bytes)][AuthTag (16 bytes)][Encrypted Data (variable)]
```

The KeyID is embedded in the ciphertext, allowing Decrypt to find the correct key without requiring KeyId as a parameter (matching AWS behavior).

### EncryptionContext

Optional authenticated associated data (AAD) that binds the encrypted data to a specific context:

**Usage Example**: Encrypt database credentials with context that identifies the database
```python
context = {
    "Database": "prod-postgresql",
    "Environment": "Production"
}

# Encrypt with context
response = kms.encrypt(
    KeyId="key-id",
    Plaintext=b"password",
    EncryptionContext=context
)

# Decrypt requires the SAME context
plaintext = kms.decrypt(
    CiphertextBlob=response["CiphertextBlob"],
    EncryptionContext=context
)
# Success!

# Decrypt with DIFFERENT context - FAILS
plaintext = kms.decrypt(
    CiphertextBlob=response["CiphertextBlob"],
    EncryptionContext={"Database": "dev-postgresql"}
)
# Raises: InvalidCiphertextException - authentication tag verification failed
```

**Use Cases for EncryptionContext**:
- Bind encrypted data to specific users/roles
- Prevent reuse of encrypted data in different contexts
- Add fine-grained audit trails (context appears in CloudTrail)
- Protect against tampering

### Envelope Encryption Pattern

GenerateDataKey enables secure envelope encryption for large data:

```python
# 1. Generate data key with CMK
response = kms.generate_data_key(KeyId=cmk_key_id, KeySpec='AES_256')
plaintext_key = response['Plaintext']  # Use immediately to encrypt data
encrypted_key = response['CiphertextBlob']  # Store with encrypted data

# 2. Encrypt large file with plaintext key (fast, no AWS calls)
encrypted_file = aes256_encrypt(large_file, plaintext_key)

# 3. Store encrypted file + encrypted key + metadata
store({
    'file': encrypted_file,
    'key': encrypted_key,  # Store encrypted key, not plaintext
    'context': {...}
})

# Later: decrypt file
# 1. Decrypt key with KMS
decrypted_key_resp = kms.decrypt(CiphertextBlob=stored_encrypted_key)
decrypted_key = decrypted_key_resp['Plaintext']

# 2. Decrypt file with decrypted key
plaintext_file = aes256_decrypt(encrypted_file, decrypted_key)
```

**Benefits**:
- No plaintext key at rest
- Only CMK access requires KMS calls
- Bulk encryption/decryption is fast
- Audit trail shows which CMK protected which data

### Cryptographic Operation Error Handling

| Scenario | Exception | HTTP | Notes |
|----------|-----------|------|-------|
| Plaintext is empty | ValidationException | 400 | Must be 1-4096 bytes |
| Plaintext > 4096 bytes | ValidationException | 400 | Size limit exceeded |
| CiphertextBlob invalid | ValidationException | 400 | Not valid base64 or too short |
| Key is Disabled | DisabledException | 400 | Enable key first |
| Key pending deletion | KMSInvalidStateException | 400 | Cancel deletion or wait |
| Authentication tag fails | InvalidCiphertextException | 400 | Ciphertext tampered or wrong context |
| EncryptionContext mismatch | InvalidCiphertextException | 400 | Must use same context for decrypt |
| Wrong key used | InvalidCiphertextException | 400 | Key ID embedded in blob doesn't match |

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
