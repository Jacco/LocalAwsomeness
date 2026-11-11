# S3 State Structure - Inspection Guide

## Overview

This document explains how S3 state is structured in the simulator, with examples of what it looks like when objects are stored.

## State Hierarchy

```
S3State
└── s3: Record<string, S3Bucket>
    └── [bucketName]: S3Bucket
        ├── BucketName: string
        ├── CreationDate: string (ISO 8601)
        ├── Region: string
        ├── Tags: Tag[]
        ├── Arn: string
        ├── Objects: Record<string, S3Object>
        │   └── [objectKey]: S3Object
        │       ├── Key: string
        │       ├── Size: number (bytes)
        │       ├── LastModified: string (ISO 8601)
        │       ├── ETag: string
        │       ├── StorageClass: 'STANDARD'
        │       ├── ContentType: string
        │       ├── Body: string | Buffer
        │       └── Arn: string
        └── BucketPolicy?: Record<string, any> (AWS IAM policy document)
```

## Example: Two Buckets with Multiple Objects

See `example-state-with-objects.json` for a complete example showing:

### Bucket 1: `my-documents`
- **4 objects** with nested paths:
  - `README.md` (root level)
  - `logs/2024-11-11.log` (nested)
  - `logs/2024-11-10.log` (nested)
  - `data/users.csv` (nested)
- **Bucket Policy** with permissions for Lambda execution

### Bucket 2: `application-backups`
- **2 objects** representing backup archives:
  - `backup-2024-11-11.tar.gz`
  - `backup-2024-11-10.tar.gz`

## Key Observations

### 1. Nested Keys are Just Paths
```json
"logs/2024-11-11.log": { "Key": "logs/2024-11-11.log", ... }
```
The slash is just part of the key string - S3 doesn't have true directories, only objects with key names that contain slashes.

### 2. Object Metadata
Each object stores:
- **Key**: Full path/name
- **Size**: Content length in bytes
- **LastModified**: ISO 8601 timestamp
- **ETag**: Entity tag (simplified hash in simulator)
- **StorageClass**: Always "STANDARD" for simulator
- **ContentType**: MIME type from HTTP headers
- **Body**: Actual content (string or Buffer)
- **Arn**: S3 ARN pointing to this object

### 3. Bucket Policy Structure
Follows AWS IAM policy format:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow|Deny",
      "Principal": { "AWS": "arn:..." },
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::bucket", "arn:aws:s3:::bucket/*"]
    }
  ]
}
```

## How State is Stored

In the simulator:
- **Per-account**: `s3State[account]` map holds all buckets for that account
- **In-memory**: State stored in JavaScript/TypeScript memory (not persisted to disk by default)
- **Account isolation**: Each AWS account has its own separate S3 state

Example from `service.ts`:
```typescript
const s3State: Record<string, Record<string, any>> = {}

function getS3State(account: string): Record<string, any> {
  if (!s3State[account]) {
    s3State[account] = {}
  }
  return s3State[account]
}

function saveS3State(account: string, state: Record<string, any>) {
  s3State[account] = state
}
```

## Object Key Examples

S3 supports any character in object keys except null. Common patterns:

```
Simple files at root:
  - README.md
  - config.json
  - data.csv

Nested with slashes (pseudo-directories):
  - logs/2024/01/01/app.log
  - data/users/alice.json
  - backups/daily/db-backup.sql

URL-like paths:
  - api/v1/users/123/profile.json
  - static/css/style.min.css
  - uploads/2024-11-11/file.zip

Special characters (URL-encoded in HTTP):
  - file with spaces.txt  (HTTP: file%20with%20spaces.txt)
  - data-v2.0.json
  - image_2024-11-11_10-30-45.png
```

## How to Inspect State

### 1. Via Tests
The test file shows how to access state directly:
```typescript
import { createBucketOp, putObjectOp } from '@/app/api/s3/s3'
import type { S3State } from '@/app/api/s3/s3'

const state: S3State = {}
// After operations, state contains:
// state.s3['bucket-name'].Objects['key'].Body
```

### 2. Via API Calls
```bash
# List all objects
curl -X GET "http://localhost:3000/api/s3/my-bucket?list-type=2"

# Get an object
curl -X GET "http://localhost:3000/api/s3/my-bucket/logs/2024-11-11.log"

# Get bucket policy
curl -X GET "http://localhost:3000/api/s3/my-bucket?policy"
```

### 3. Via JSON File
The `example-state-with-objects.json` shows what the state looks like when serialized.

## Content Types Commonly Used

```
text/plain          - .txt, .log, .conf
text/markdown       - .md
text/csv            - .csv
application/json    - .json
application/xml     - .xml
application/gzip    - .tar.gz, .gz
application/zip     - .zip
image/png           - .png
image/jpeg          - .jpg, .jpeg
binary/octet-stream - Any binary data
```

## Size Examples

```
Small text file:     512 - 4,096 bytes
Medium file:         1 MB - 10 MB (1,048,576 - 10,485,760 bytes)
Large file:          100 MB+ (104,857,600+ bytes)
```

## Future Persistence

Currently, S3 state is in-memory only. To make it persistent:
1. Add `loadS3State(account)` from database on startup
2. Modify `saveS3State(account, state)` to write to database
3. Use same pattern as EC2: `src/app/api/db/s3/state.ts`

## ARN Format

```
Bucket ARN:    arn:aws:s3:::bucket-name
Object ARN:    arn:aws:s3:::bucket-name/object-key
Policy ARN:    arn:aws:s3:::bucket-name/*   (all objects)
```

Example from state:
```json
{
  "Arn": "arn:aws:s3:::my-documents",
  "Objects": {
    "logs/2024-11-11.log": {
      "Arn": "arn:aws:s3:::my-documents/logs/2024-11-11.log"
    }
  }
}
```

## Related Files

- `src/app/api/s3/s3.ts` - State structure definitions (S3State, S3Bucket, S3Object)
- `src/app/api/s3/service.ts` - State management functions
- `db/s3/example-state-with-objects.json` - Concrete example

## See Also

- `S3_QUICK_REFERENCE.md` - How to use S3 API
- `src/app/api/__tests__/s3.test.ts` - Test examples of state operations
