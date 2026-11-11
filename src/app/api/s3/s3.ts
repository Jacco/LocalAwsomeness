import { AwsError } from '../common'
import { s3Storage, type S3BucketMetadata, type S3ObjectMetadata } from './storage'
import { checkKmsPermission, generateKmsAccessDeniedError } from '../kms/validator'
import { logCloudTrailEvent } from '../cloudtrail/cloudtrail'
import { validateBucketPolicy } from './policy'

// S3 request types
export interface Req<P = any> {
  params: P
  // The account that owns the bucket of the request (or the caller's, when there is no bucket or it does not exist yet).
  account: string
  // The account of the caller, when it is not the owner (a cross-account request).
  callerAccount?: string
  region: string
  principal?: string
}

export type Op = (req: Req) => unknown

// Legacy types maintained for compatibility
export interface S3State {
  s3?: Record<string, any>
}

// Only the account that owns a bucket manages its policy: another account gets 405 even when the policy lets it (AWS:
// "If you have the correct permissions, but you're not using an identity that belongs to the bucket owner's account,
// Amazon S3 returns a 405 Method Not Allowed error").
function assertBucketOwner({ account, callerAccount }: Req) {
  if (callerAccount !== undefined && callerAccount !== account) {
    throw new AwsError('MethodNotAllowed', 'The specified method is not allowed against this resource.', 405)
  }
}

// S3 Operations (file-based)

export const createBucketOp: Op = ({ params, account, callerAccount, region }) => {
  const bucketName = params.Bucket
  
  if (!bucketName) {
    throw new AwsError('MissingParameter', 'The Bucket parameter is required', 400)
  }

  // A new bucket belongs to the caller; `account` is the owner of an existing bucket of this name, if there is one.
  const creator = callerAccount ?? account
  const owner = s3Storage.findBucketOwner(bucketName)
  if (owner === creator) {
    throw new AwsError('BucketAlreadyOwnedByYou', 'Your previous request to create the named bucket succeeded and you already own it.', 409)
  }
  if (owner !== undefined) {
    throw new AwsError('BucketAlreadyExists', 'The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.', 409)
  }

  s3Storage.createBucket(creator, bucketName, region)
  return { Location: `/${bucketName}` }
}

export const deleteBucketOp: Op = ({ params, account }) => {
  const bucketName = params.Bucket
  
  if (!bucketName) {
    throw new AwsError('MissingParameter', 'The Bucket parameter is required', 400)
  }

  if (!s3Storage.bucketExists(account, bucketName)) {
    throw new AwsError('NoSuchBucket', `The specified bucket does not exist: ${bucketName}`)
  }

  const objects = s3Storage.listObjects(account, bucketName)
  if (objects.length > 0) {
    throw new AwsError('BucketNotEmpty', 'The bucket you tried to delete is not empty')
  }

  s3Storage.deleteBucket(account, bucketName)
  return {}
}

export const listBucketsOp: Op = ({ account }) => {
  const buckets = s3Storage.listBuckets(account).map(b => ({
    Name: b.BucketName,
    CreationDate: b.CreationDate,
  }))

  return {
    Buckets: buckets,
    Owner: {
      DisplayName: 'owner',
      ID: 'owner-id',
    },
  }
}

export const headBucketOp: Op = ({ params, account }) => {
  const bucketName = params.Bucket
  
  if (!bucketName) {
    throw new AwsError('MissingParameter', 'The Bucket parameter is required', 400)
  }

  if (!s3Storage.bucketExists(account, bucketName)) {
    throw new AwsError('NotFound', `The specified bucket does not exist: ${bucketName}`)
  }

  return { BucketRegion: s3Storage.getBucketMetadata(account, bucketName)?.Region }
}

export const putBucketPolicyOp: Op = (req) => {
  const { params, account } = req
  const bucketName = params.Bucket
  
  if (!bucketName) {
    throw new AwsError('MissingParameter', 'The Bucket parameter is required', 400)
  }

  if (!s3Storage.bucketExists(account, bucketName)) {
    throw new AwsError('NoSuchBucket', `The specified bucket does not exist: ${bucketName}`)
  }
  assertBucketOwner(req)

  if (!params.Policy) {
    throw new AwsError('MissingParameter', 'The Policy parameter is required', 400)
  }

  let policyDocument: Record<string, any>
  try {
    policyDocument = typeof params.Policy === 'string' 
      ? JSON.parse(params.Policy) 
      : params.Policy
  } catch {
    throw new AwsError('MalformedPolicy', 'Policies must be valid JSON and the first byte must be \'{\'', 400)
  }
  validateBucketPolicy(bucketName, policyDocument)

  s3Storage.putBucketPolicy(account, bucketName, policyDocument)
  return {}
}

export const getBucketPolicyOp: Op = (req) => {
  const { params, account } = req
  const bucketName = params.Bucket
  
  if (!bucketName) {
    throw new AwsError('MissingParameter', 'The Bucket parameter is required', 400)
  }

  if (!s3Storage.bucketExists(account, bucketName)) {
    throw new AwsError('NoSuchBucket', `The specified bucket does not exist: ${bucketName}`)
  }
  assertBucketOwner(req)

  const policy = s3Storage.getBucketPolicy(account, bucketName)
  if (!policy) {
    throw new AwsError('NoSuchBucketPolicy', `The bucket policy does not exist`)
  }

  return { Policy: JSON.stringify(policy) }
}

export const deleteBucketPolicyOp: Op = (req) => {
  const { params, account } = req
  const bucketName = params.Bucket
  
  if (!bucketName) {
    throw new AwsError('MissingParameter', 'The Bucket parameter is required', 400)
  }

  if (!s3Storage.bucketExists(account, bucketName)) {
    throw new AwsError('NoSuchBucket', `The specified bucket does not exist: ${bucketName}`)
  }
  assertBucketOwner(req)

  s3Storage.deleteBucketPolicy(account, bucketName)
  return {}
}

export const putObjectOp: Op = ({ params, account, principal, region }) => {
  const bucketName = params.Bucket
  const objectKey = params.Key
  
  if (!bucketName) {
    throw new AwsError('MissingParameter', 'The Bucket parameter is required', 400)
  }
  if (!objectKey) {
    throw new AwsError('MissingParameter', 'The Key parameter is required', 400)
  }

  if (!s3Storage.bucketExists(account, bucketName)) {
    throw new AwsError('NoSuchBucket', `The specified bucket does not exist: ${bucketName}`)
  }

  const body = params.Body || ''
  const contentType = params.ContentType || 'application/octet-stream'
  
  // Check for bucket-level default encryption
  const bucketEncryption = s3Storage.getBucketEncryption(account, bucketName)
  let encryptionConfig: any = undefined

  if (bucketEncryption) {
    // Get the KMS key ID from default encryption config
    const keyId = bucketEncryption.Rules[0]?.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID
    if (keyId && principal) {
      // Validate KMS permission to generate data key
      const permissionCheck = checkKmsPermission(account, principal, keyId, 'kms:GenerateDataKey')
      if (!permissionCheck.allowed) {
        // Log KMS permission denial to CloudTrail
        logCloudTrailEvent({
          timestamp: new Date().toISOString(),
          principal,
          service: 'kms',
          action: 'GenerateDataKey',
          resource: permissionCheck.keyArn || `arn:aws:kms:${region}:${account}:key/${keyId}`,
          authorizationDecision: 'deny',
          authorizationReason: permissionCheck.reason,
          account,
          region: region || 'us-east-1',
          parameters: { keyId, operation: 'PutObject' },
          errorCode: 'AccessDenied'
        })

        throw new AwsError(
          'AccessDenied',
          generateKmsAccessDeniedError(principal, 'kms:GenerateDataKey', permissionCheck.keyArn || keyId).message,
          403
        )
      }

      // Log successful KMS permission check
      logCloudTrailEvent({
        timestamp: new Date().toISOString(),
        principal,
        service: 'kms',
        action: 'GenerateDataKey',
        resource: permissionCheck.keyArn || `arn:aws:kms:${region}:${account}:key/${keyId}`,
        authorizationDecision: 'allow',
        account,
        region: region || 'us-east-1',
        parameters: { keyId, operation: 'PutObject' }
      })

      // Set encryption config for storage layer
      encryptionConfig = {
        ServerSideEncryption: 'aws:kms' as const,
        SSEKMSKeyId: keyId,
      }
    }
  }

  const result = s3Storage.putObject(account, bucketName, objectKey, body, contentType, encryptionConfig)
  return { ...result, ...encryptionConfig }
}

export const getObjectOp: Op = ({ params, account, principal, region }) => {
  const bucketName = params.Bucket
  const objectKey = params.Key
  
  if (!bucketName) {
    throw new AwsError('MissingParameter', 'The Bucket parameter is required', 400)
  }
  if (!objectKey) {
    throw new AwsError('MissingParameter', 'The Key parameter is required', 400)
  }

  if (!s3Storage.bucketExists(account, bucketName)) {
    throw new AwsError('NoSuchBucket', `The specified bucket does not exist: ${bucketName}`)
  }

  const obj = s3Storage.getObject(account, bucketName, objectKey)
  if (!obj) {
    throw new AwsError('NoSuchKey', `The specified key does not exist.`)
  }

  // Check if object is encrypted and validate KMS permission
  if (obj.metadata.Encrypted && obj.metadata.SSEKMSKeyId && principal) {
    const permissionCheck = checkKmsPermission(account, principal, obj.metadata.SSEKMSKeyId, 'kms:Decrypt')
    if (!permissionCheck.allowed) {
      // Log KMS permission denial to CloudTrail
      logCloudTrailEvent({
        timestamp: new Date().toISOString(),
        principal,
        service: 'kms',
        action: 'Decrypt',
        resource: permissionCheck.keyArn || `arn:aws:kms:${region}:${account}:key/${obj.metadata.SSEKMSKeyId}`,
        authorizationDecision: 'deny',
        authorizationReason: permissionCheck.reason,
        account,
        region: region || 'us-east-1',
        parameters: { keyId: obj.metadata.SSEKMSKeyId, operation: 'GetObject' },
        errorCode: 'AccessDenied'
      })

      throw new AwsError(
        'AccessDenied',
        generateKmsAccessDeniedError(principal, 'kms:Decrypt', permissionCheck.keyArn || obj.metadata.SSEKMSKeyId).message,
        403
      )
    }

    // Log successful KMS permission check
    logCloudTrailEvent({
      timestamp: new Date().toISOString(),
      principal,
      service: 'kms',
      action: 'Decrypt',
      resource: permissionCheck.keyArn || `arn:aws:kms:${region}:${account}:key/${obj.metadata.SSEKMSKeyId}`,
      authorizationDecision: 'allow',
      account,
      region: region || 'us-east-1',
      parameters: { keyId: obj.metadata.SSEKMSKeyId, operation: 'GetObject' }
    })
  }

  return {
    Body: obj.content,
    ContentLength: obj.metadata.Size,
    ContentType: obj.metadata.ContentType,
    LastModified: obj.metadata.LastModified,
    ETag: obj.metadata.ETag,
    VersionId: obj.metadata.VersionId,
    ServerSideEncryption: obj.metadata.ServerSideEncryption,
    SSEKMSKeyId: obj.metadata.SSEKMSKeyId,
  }
}

export const deleteObjectOp: Op = ({ params, account }) => {
  const bucketName = params.Bucket
  const objectKey = params.Key
  
  if (!bucketName) {
    throw new AwsError('MissingParameter', 'The Bucket parameter is required', 400)
  }
  if (!objectKey) {
    throw new AwsError('MissingParameter', 'The Key parameter is required', 400)
  }

  if (!s3Storage.bucketExists(account, bucketName)) {
    throw new AwsError('NoSuchBucket', `The specified bucket does not exist: ${bucketName}`)
  }

  const versionId = s3Storage.deleteObject(account, bucketName, objectKey)
  return { VersionId: versionId }
}

export const headObjectOp: Op = ({ params, account }) => {
  const bucketName = params.Bucket
  const objectKey = params.Key
  
  if (!bucketName) {
    throw new AwsError('MissingParameter', 'The Bucket parameter is required', 400)
  }
  if (!objectKey) {
    throw new AwsError('MissingParameter', 'The Key parameter is required', 400)
  }

  if (!s3Storage.bucketExists(account, bucketName)) {
    throw new AwsError('NoSuchBucket', `The specified bucket does not exist: ${bucketName}`)
  }

  const metadata = s3Storage.headObject(account, bucketName, objectKey)
  if (!metadata) {
    throw new AwsError('NoSuchKey', `The specified key does not exist.`)
  }

  return {
    ContentLength: metadata.Size,
    ContentType: metadata.ContentType,
    LastModified: metadata.LastModified,
    ETag: metadata.ETag,
    VersionId: metadata.VersionId,
    ServerSideEncryption: metadata.ServerSideEncryption,
    SSEKMSKeyId: metadata.SSEKMSKeyId,
  }
}

export const listObjectsV2Op: Op = ({ params, account }) => {
  const bucketName = params.Bucket
  
  if (!bucketName) {
    throw new AwsError('MissingParameter', 'The Bucket parameter is required', 400)
  }

  if (!s3Storage.bucketExists(account, bucketName)) {
    throw new AwsError('NoSuchBucket', `The specified bucket does not exist: ${bucketName}`)
  }

  const prefix: string = params.Prefix || ''
  const delimiter: string | undefined = params.Delimiter || undefined
  const maxKeys: number = Math.min(Number.isInteger(params.MaxKeys) && params.MaxKeys >= 0 ? params.MaxKeys : 1000, 1000)
  let startAfter: string = params.StartAfter ?? ''
  if (params.ContinuationToken) {
    startAfter = Buffer.from(params.ContinuationToken, 'base64url').toString('utf8')
  }

  // Objects and common prefixes in key order; a common prefix counts as one entry.
  const entries: Array<{ prefix: string } | { object: S3ObjectMetadata }> = []
  const seenPrefixes = new Set<string>()
  for (const obj of s3Storage.listObjects(account, bucketName, prefix)) {
    if (obj.Key <= startAfter) continue
    const rest = obj.Key.slice(prefix.length)
    const cut = delimiter ? rest.indexOf(delimiter) : -1
    if (cut >= 0) {
      const common = prefix + rest.slice(0, cut + delimiter!.length)
      if (common <= startAfter || seenPrefixes.has(common)) continue
      seenPrefixes.add(common)
      entries.push({ prefix: common })
    } else {
      entries.push({ object: obj })
    }
  }

  const page = entries.slice(0, maxKeys)
  const isTruncated = entries.length > page.length
  const last = page.at(-1)
  const lastKey = last && ('prefix' in last ? last.prefix : last.object.Key)
  const encode = (value: string | undefined) =>
    value !== undefined && params.EncodingType === 'url' ? encodeURIComponent(value).replace(/%2F/g, '/') : value

  return {
    Name: bucketName,
    Prefix: encode(prefix),
    Delimiter: encode(delimiter),
    MaxKeys: maxKeys,
    KeyCount: page.length,
    IsTruncated: isTruncated,
    EncodingType: params.EncodingType,
    ContinuationToken: params.ContinuationToken,
    NextContinuationToken: isTruncated && lastKey ? Buffer.from(lastKey, 'utf8').toString('base64url') : undefined,
    StartAfter: encode(params.StartAfter),
    Contents: page.flatMap(e => 'object' in e ? [{
      Key: encode(e.object.Key),
      LastModified: e.object.LastModified,
      ETag: e.object.ETag,
      Size: e.object.Size,
      StorageClass: e.object.StorageClass,
    }] : []),
    CommonPrefixes: page.flatMap(e => 'prefix' in e ? [{ Prefix: encode(e.prefix) }] : []),
  }
}
