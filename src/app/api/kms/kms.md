we don't encrypt enything just register the keys

but we validate access

(The plan that builds on this, with fake encryption for services, real crypto for manual use, key policy conflict tracking and ACM: [docs/encryption-plan.md](../../../../docs/encryption-plan.md).)

Key
===
CancelKeyDeletion
CreateGrant
CreateKey
DescribeKey
DisableKey
DisableKeyRotation
EnableKey
EnableKeyRotation
GetKeyPolicy
GetKeyRotationStatus
GetPublicKey
ListKeyPolicies
ListKeyRotations
ListKeys
ListGrants
ListRetirableGrants
PutKeyPolicy
ReplicateKey
RetireGrant
RevokeGrant
RotateKeyOnDemand
ScheduleKeyDeletion
UpdateKeyDescription
UpdatePrimaryRegion

Alias
=====
CreateAlias
DeleteAlias
ListAliases
UpdateAlias

CustomKeyStore
==============
ConnectCustomKeyStore
CreateCustomKeyStore
DeleteCustomKeyStore
DescribeCustomKeyStores
DisconnectCustomKeyStore
UpdateCustomKeyStore

ImportedKey
===========
DeleteImportedKeyMaterial
GetParametersForImport
ImportKeyMaterial

Dataplane
=========
Decrypt
DeriveSharedSecret
Encrypt
GenerateDataKey
GenerateDataKeyPair
GenerateDataKeyPairWithoutPlaintext
GenerateDataKeyWithoutPlaintext
GenerateMac
GenerateRandom
ReEncrypt
Sign
Verify
VerifyMac

Miscelanious
============
ListResourceTags
TagResource
UntagResource
