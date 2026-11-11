/**
 * File-based S3 storage with versioning and metadata support
 * 
 * Directory structure:
 * data/accounts/{account}/s3/
 *   buckets.json              - Maps sanitized bucket names to real names
 *   {bucket-name}/
 *     bucket.json             - Bucket metadata (creation date, policy, etc.)
 *     objects/
 *       {key}/
 *         (nested folders for pseudo-directories)
 *         versions.json       - Version history (tracks next version number)
 *         v{n}/
 *           content{ext}      - Object content (with extension for syntax highlighting)
 *           metadata.json     - Object metadata (size, ETag, LastModified, etc.)
 * 
 * Example:
 * data/accounts/123456789012/s3/
 *   buckets.json              {"my-documents": "my-documents"}
 *   my-documents/
 *     bucket.json
 *     objects/
 *       README.md/
 *         versions.json       [{"versionId": "v1", "isLatest": true, ...}]
 *         v1/
 *           content.md        (extension from metadata)
 *           metadata.json
 *       logs/
 *         2024-11-11.log/
 *           versions.json
 *           v1/
 *             content.log
 *             metadata.json
 *         2024-11-10.log/
 *           versions.json
 *           v1/
 *             content.log
 *             metadata.json
 *           v2/
 *             content.log
 *             metadata.json
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const DATA_DIR = process.env.JPK_DB_ROOT || path.join(process.cwd(), 'data')

export interface S3ObjectMetadata {
  Key: string
  Size: number
  LastModified: string
  ETag: string
  StorageClass: 'STANDARD'
  ContentType: string
  VersionId: string
  IsLatest: boolean
  CreatedAt: string
  // KMS encryption fields
  ServerSideEncryption?: 'aws:kms'
  SSEKMSKeyId?: string
  Encrypted?: boolean
}

export interface S3ServerSideEncryptionConfig {
  Rules: Array<{
    ApplyServerSideEncryptionByDefault: {
      SSEAlgorithm: 'aws:kms'
      KMSMasterKeyID: string
    }
  }>
}

export interface S3BucketMetadata {
  BucketName: string
  CreationDate: string
  Region: string
  Arn: string
  Policy?: Record<string, any>
  Tags: Array<{ Key: string; Value: string }>
  // KMS encryption configuration
  ServerSideEncryption?: S3ServerSideEncryptionConfig
}

/**
 * Sanitize bucket name for filesystem use
 * AWS S3 bucket names: 3-63 chars, lowercase, numbers, hyphens
 * For now, we just map them; could apply transformations if needed
 */
// Valid bucket names are [a-z0-9.-] (checked when a bucket is created), so this only guards against odd input: two valid
// names never share a directory, which a global bucket namespace relies on.
function sanitizeBucketName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9.-]/g, '-').replace(/^\.+/, '-')
}

/**
 * Get file extension for content type
 * Used to name content files (content.json, content.log, etc.)
 */
function getContentExtension(contentType: string): string {
  const mapping: Record<string, string> = {
    'application/json': 'json',
    'text/plain': 'log',
    'text/markdown': 'md',
    'text/html': 'html',
    'text/csv': 'csv',
    'application/xml': 'xml',
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
  }
  
  // Try direct match first
  if (mapping[contentType]) {
    return mapping[contentType]
  }
  
  // Try pattern match for charset
  const baseType = contentType.split(';')[0].trim()
  if (mapping[baseType]) {
    return mapping[baseType]
  }
  
  // Extract extension from content type
  if (baseType.includes('text/')) {
    return 'txt'
  }
  if (baseType.includes('image/')) {
    return 'bin'
  }
  
  // Default
  return 'bin'
}

export class S3FileStorage {
  /**
   * Get path to account's S3 data directory
   */
  private getAccountS3Dir(account: string): string {
    return path.join(DATA_DIR, 'accounts', account, 's3')
  }

  /**
   * Get path to buckets mapping file
   */
  private getBucketsMapFile(account: string): string {
    return path.join(this.getAccountS3Dir(account), 'buckets.json')
  }

  /**
   * Get path to bucket directory
   */
  private getBucketDir(account: string, bucket: string): string {
    const safe = sanitizeBucketName(bucket)
    return path.join(this.getAccountS3Dir(account), safe)
  }

  /**
   * Get path to bucket metadata file
   */
  private getBucketMetadataFile(account: string, bucket: string): string {
    return path.join(this.getBucketDir(account, bucket), 'bucket.json')
  }

  /**
   * Get path to object directory (handling nested keys with actual folders)
   * S3 key "logs/2024-11-11.log" becomes path logs/2024-11-11.log/
   */
  private getObjectDir(account: string, bucket: string, key: string): string {
    const objectsDir = path.join(this.getBucketDir(account, bucket), 'objects')
    // Use actual folder structure for nested keys
    return path.join(objectsDir, key)
  }

  /**
   * Get path to object versions file
   */
  private getVersionsFile(account: string, bucket: string, key: string): string {
    return path.join(this.getObjectDir(account, bucket, key), 'versions.json')
  }

  /**
   * Get path to specific version directory
   */
  private getVersionDir(account: string, bucket: string, key: string, versionId: string): string {
    return path.join(this.getObjectDir(account, bucket, key), versionId)
  }

  /**
   * Get path to version content file (with extension)
   */
  private getVersionContentFile(
    account: string,
    bucket: string,
    key: string,
    versionId: string,
    contentType: string
  ): string {
    const ext = getContentExtension(contentType)
    return path.join(this.getVersionDir(account, bucket, key, versionId), `content.${ext}`)
  }

  /**
   * Get path to version metadata file
   */
  private getVersionMetadataFile(account: string, bucket: string, key: string, versionId: string): string {
    return path.join(this.getVersionDir(account, bucket, key, versionId), 'metadata.json')
  }

  /**
   * Create directories recursively
   */
  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
  }

  /**
   * Generate ETag from content
   */
  private generateETag(content: Buffer | string): string {
    const buffer = typeof content === 'string' ? Buffer.from(content) : content
    return '"' + crypto.createHash('md5').update(buffer).digest('hex') + '"'
  }

  /**
   * Update bucket mapping file
   */
  private updateBucketsMap(account: string, realName: string, sanitizedName: string): void {
    const mapFile = this.getBucketsMapFile(account)
    let mapping: Record<string, string> = {}
    
    if (fs.existsSync(mapFile)) {
      mapping = JSON.parse(fs.readFileSync(mapFile, 'utf-8'))
    }
    
    mapping[sanitizedName] = realName
    fs.writeFileSync(mapFile, JSON.stringify(mapping, null, 2))
  }

  /**
   * Create a bucket
   */
  createBucket(account: string, bucketName: string, region: string): S3BucketMetadata {
    const bucketDir = this.getBucketDir(account, bucketName)
    this.ensureDir(bucketDir)

    const metadata: S3BucketMetadata = {
      BucketName: bucketName,
      CreationDate: new Date().toISOString(),
      Region: region,
      Arn: `arn:aws:s3:::${bucketName}`,
      Tags: [],
    }

    // Create bucket metadata file
    fs.writeFileSync(
      this.getBucketMetadataFile(account, bucketName),
      JSON.stringify(metadata, null, 2)
    )

    // Create objects directory
    this.ensureDir(path.join(bucketDir, 'objects'))

    // Update bucket mapping
    this.updateBucketsMap(account, bucketName, sanitizeBucketName(bucketName))

    return metadata
  }

  /**
   * Get bucket metadata
   */
  getBucketMetadata(account: string, bucketName: string): S3BucketMetadata | null {
    const metadataFile = this.getBucketMetadataFile(account, bucketName)
    if (!fs.existsSync(metadataFile)) {
      return null
    }
    const metadata: S3BucketMetadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'))
    return metadata.BucketName === bucketName ? metadata : null
  }

  /**
   * The account that owns a bucket. Bucket names are global: one account at most has a bucket of a given name.
   */
  findBucketOwner(bucketName: string): string | undefined {
    const accountsDir = path.join(DATA_DIR, 'accounts')
    if (!fs.existsSync(accountsDir)) {
      return undefined
    }
    return fs.readdirSync(accountsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
      .find(account => this.getBucketMetadata(account, bucketName) !== null)
  }

  /**
   * List all buckets in account
   */
  listBuckets(account: string): S3BucketMetadata[] {
    const s3Dir = this.getAccountS3Dir(account)
    if (!fs.existsSync(s3Dir)) {
      return []
    }

    const buckets: S3BucketMetadata[] = []
    const entries = fs.readdirSync(s3Dir, { withFileTypes: true })

    for (const entry of entries) {
      // Skip buckets.json file
      if (entry.name === 'buckets.json') {
        continue
      }
      
      if (entry.isDirectory()) {
        const metadataFile = path.join(s3Dir, entry.name, 'bucket.json')
        if (fs.existsSync(metadataFile)) {
          buckets.push(JSON.parse(fs.readFileSync(metadataFile, 'utf-8')))
        }
      }
    }

    return buckets
  }

  /**
   * Delete a bucket (and all its contents)
   */
  deleteBucket(account: string, bucketName: string): void {
    const bucketDir = this.getBucketDir(account, bucketName)
    if (fs.existsSync(bucketDir)) {
      fs.rmSync(bucketDir, { recursive: true, force: true })
    }
  }

  /**
   * Check if bucket exists
   */
  bucketExists(account: string, bucketName: string): boolean {
    return this.getBucketMetadata(account, bucketName) !== null
  }

  /**
   * Put bucket policy
   */
  putBucketPolicy(account: string, bucketName: string, policy: Record<string, any>): void {
    const metadata = this.getBucketMetadata(account, bucketName)
    if (!metadata) {
      throw new Error('Bucket not found')
    }

    metadata.Policy = policy
    fs.writeFileSync(
      this.getBucketMetadataFile(account, bucketName),
      JSON.stringify(metadata, null, 2)
    )
  }

  /**
   * Get bucket policy
   */
  getBucketPolicy(account: string, bucketName: string): Record<string, any> | null {
    const metadata = this.getBucketMetadata(account, bucketName)
    return metadata?.Policy ?? null
  }

  /**
   * Delete bucket policy
   */
  deleteBucketPolicy(account: string, bucketName: string): void {
    const metadata = this.getBucketMetadata(account, bucketName)
    if (!metadata) {
      throw new Error('Bucket not found')
    }

    delete metadata.Policy
    fs.writeFileSync(
      this.getBucketMetadataFile(account, bucketName),
      JSON.stringify(metadata, null, 2)
    )
  }

  /**
   * Set default encryption for a bucket
   */
  setBucketEncryption(
    account: string,
    bucketName: string,
    keyId: string
  ): void {
    const metadata = this.getBucketMetadata(account, bucketName)
    if (!metadata) {
      throw new Error('Bucket not found')
    }

    metadata.ServerSideEncryption = {
      Rules: [
        {
          ApplyServerSideEncryptionByDefault: {
            SSEAlgorithm: 'aws:kms',
            KMSMasterKeyID: keyId,
          },
        },
      ],
    }

    fs.writeFileSync(
      this.getBucketMetadataFile(account, bucketName),
      JSON.stringify(metadata, null, 2)
    )
  }

  /**
   * Get default encryption config for a bucket
   */
  getBucketEncryption(account: string, bucketName: string): S3ServerSideEncryptionConfig | null {
    const metadata = this.getBucketMetadata(account, bucketName)
    if (!metadata) {
      return null
    }

    return metadata.ServerSideEncryption || null
  }

  /**
   * Delete encryption config from bucket
   */
  deleteBucketEncryption(account: string, bucketName: string): void {
    const metadata = this.getBucketMetadata(account, bucketName)
    if (!metadata) {
      throw new Error('Bucket not found')
    }

    delete metadata.ServerSideEncryption
    fs.writeFileSync(
      this.getBucketMetadataFile(account, bucketName),
      JSON.stringify(metadata, null, 2)
    )
  }

  /**
   * Put object (creates new version)
   */
  putObject(
    account: string,
    bucketName: string,
    key: string,
    content: Buffer | string,
    contentType: string,
    encryptionConfig?: { ServerSideEncryption?: 'aws:kms'; SSEKMSKeyId?: string }
  ): { VersionId: string; ETag: string } {
    const objectDir = this.getObjectDir(account, bucketName, key)
    this.ensureDir(objectDir)

    const versionsFile = this.getVersionsFile(account, bucketName, key)
    let versions: any[] = []
    let nextVersion = 1

    if (fs.existsSync(versionsFile)) {
      versions = JSON.parse(fs.readFileSync(versionsFile, 'utf-8'))
      // Find highest version number
      nextVersion = Math.max(...versions.map(v => parseInt(v.versionId.substring(1))), 0) + 1
      // Mark all previous as not latest
      versions.forEach(v => v.isLatest = false)
    }

    const versionId = `v${nextVersion}`
    const versionDir = this.getVersionDir(account, bucketName, key, versionId)
    this.ensureDir(versionDir)

    // Write content with extension
    const contentBuffer = typeof content === 'string' ? Buffer.from(content) : content
    fs.writeFileSync(
      this.getVersionContentFile(account, bucketName, key, versionId, contentType),
      contentBuffer
    )

    // Generate ETag
    const etag = this.generateETag(contentBuffer)

    // Create metadata
    const metadata: S3ObjectMetadata = {
      Key: key,
      Size: contentBuffer.length,
      LastModified: new Date().toISOString(),
      ETag: etag,
      StorageClass: 'STANDARD',
      ContentType: contentType,
      VersionId: versionId,
      IsLatest: true,
      CreatedAt: new Date().toISOString(),
    }

    // Add encryption metadata if provided
    if (encryptionConfig?.ServerSideEncryption) {
      metadata.ServerSideEncryption = encryptionConfig.ServerSideEncryption
      metadata.SSEKMSKeyId = encryptionConfig.SSEKMSKeyId
      metadata.Encrypted = true
    }

    fs.writeFileSync(
      this.getVersionMetadataFile(account, bucketName, key, versionId),
      JSON.stringify(metadata, null, 2)
    )

    // Update versions file
    versions.push({
      versionId: versionId,
      isLatest: true,
      createdAt: metadata.CreatedAt,
      size: metadata.Size,
    })

    fs.writeFileSync(versionsFile, JSON.stringify(versions, null, 2))

    return { VersionId: versionId, ETag: etag }
  }

  /**
   * Get object (latest version)
   */
  getObject(account: string, bucketName: string, key: string): {
    content: Buffer
    metadata: S3ObjectMetadata
  } | null {
    const latestVersionId = this.getLatestVersionId(account, bucketName, key)
    if (!latestVersionId) {
      return null
    }
    return this.getObjectVersion(account, bucketName, key, latestVersionId)
  }

  /**
   * Get specific object version
   */
  getObjectVersion(
    account: string,
    bucketName: string,
    key: string,
    versionId: string
  ): { content: Buffer; metadata: S3ObjectMetadata } | null {
    const metadataFile = this.getVersionMetadataFile(account, bucketName, key, versionId)

    if (!fs.existsSync(metadataFile)) {
      return null
    }

    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'))
    
    // Find content file (with any extension)
    const versionDir = this.getVersionDir(account, bucketName, key, versionId)
    const files = fs.readdirSync(versionDir)
    const contentFile = files.find(f => f.startsWith('content.'))
    
    if (!contentFile) {
      return null
    }

    const content = fs.readFileSync(path.join(versionDir, contentFile))
    return { content, metadata }
  }

  /**
   * Get latest version ID for an object
   */
  private getLatestVersionId(account: string, bucketName: string, key: string): string | null {
    const versionsFile = this.getVersionsFile(account, bucketName, key)
    if (!fs.existsSync(versionsFile)) {
      return null
    }

    const versions = JSON.parse(fs.readFileSync(versionsFile, 'utf-8'))
    const latest = versions.find((v: any) => v.isLatest)
    return latest?.versionId ?? null
  }

  /**
   * Delete object (marks latest version as deleted)
   */
  deleteObject(account: string, bucketName: string, key: string): string {
    const versionsFile = this.getVersionsFile(account, bucketName, key)

    let versions: any[] = []
    let nextVersion = 1

    if (fs.existsSync(versionsFile)) {
      versions = JSON.parse(fs.readFileSync(versionsFile, 'utf-8'))
      nextVersion = Math.max(...versions.map(v => parseInt(v.versionId.substring(1))), 0) + 1
      versions.forEach(v => v.isLatest = false)
    }

    const versionId = `v${nextVersion}`

    // Add delete marker
    versions.push({
      versionId: versionId,
      isLatest: true,
      createdAt: new Date().toISOString(),
      isDeleteMarker: true,
    })

    fs.writeFileSync(versionsFile, JSON.stringify(versions, null, 2))

    return versionId
  }

  /**
   * List object versions
   */
  listObjectVersions(account: string, bucketName: string, prefix: string = ''): S3ObjectMetadata[] {
    const bucketDir = this.getBucketDir(account, bucketName)
    const objectsDir = path.join(bucketDir, 'objects')

    if (!fs.existsSync(objectsDir)) {
      return []
    }

    const results: S3ObjectMetadata[] = []
    this.walkObjectDir(account, bucketName, objectsDir, objectsDir, prefix, results)

    return results.sort((a, b) => b.LastModified.localeCompare(a.LastModified))
  }

  /**
   * Recursively walk object directory to find all objects
   */
  private walkObjectDir(
    account: string,
    bucketName: string,
    objectsDir: string,
    currentDir: string,
    prefix: string,
    results: S3ObjectMetadata[]
  ): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        // Check if this is a versions directory (contains versions.json)
        const versionsFile = path.join(fullPath, 'versions.json')
        if (fs.existsSync(versionsFile)) {
          // This is an object directory
          const relPath = path.relative(objectsDir, fullPath)
          const key = relPath.replace(/\\/g, '/') // Normalize path separators

          if (!prefix || key.startsWith(prefix)) {
            const versions = JSON.parse(fs.readFileSync(versionsFile, 'utf-8'))
            for (const version of versions) {
              if (!version.isDeleteMarker) {
                const metadataFile = this.getVersionMetadataFile(account, bucketName, key, version.versionId)
                if (fs.existsSync(metadataFile)) {
                  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'))
                  results.push(metadata)
                }
              }
            }
          }
        } else {
          // Not an object directory, recurse
          this.walkObjectDir(account, bucketName, objectsDir, fullPath, prefix, results)
        }
      }
    }
  }

  /**
   * List objects (by prefix, latest versions only)
   */
  listObjects(account: string, bucketName: string, prefix: string = ''): S3ObjectMetadata[] {
    const allVersions = this.listObjectVersions(account, bucketName, prefix)
    const latestByKey = new Map<string, S3ObjectMetadata>()

    for (const version of allVersions) {
      if (!latestByKey.has(version.Key) || version.LastModified > latestByKey.get(version.Key)!.LastModified) {
        latestByKey.set(version.Key, version)
      }
    }

    return Array.from(latestByKey.values())
      .filter(obj => this.objectExists(account, bucketName, obj.Key))
      .sort((a, b) => a.Key.localeCompare(b.Key))
  }

  /**
   * Check if object exists
   */
  objectExists(account: string, bucketName: string, key: string): boolean {
    const versionsFile = this.getVersionsFile(account, bucketName, key)
    if (!fs.existsSync(versionsFile)) {
      return false
    }

    const versions = JSON.parse(fs.readFileSync(versionsFile, 'utf-8'))
    const latest = versions.find((v: any) => v.isLatest)
    return latest && !latest.isDeleteMarker
  }

  /**
   * Get object metadata without content
   */
  headObject(account: string, bucketName: string, key: string): S3ObjectMetadata | null {
    const obj = this.getObject(account, bucketName, key)
    return obj?.metadata ?? null
  }
}

export const s3Storage = new S3FileStorage()
