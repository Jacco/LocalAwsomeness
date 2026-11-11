# S3 File-Based Storage Guide

## Overview

The S3 simulator persists all bucket and object data to the filesystem under `data/accounts/{accountId}/s3/`. This guide documents the complete structure and design decisions.

## Directory Structure

```
data/accounts/{accountId}/s3/
├── buckets.json                    # Mapping of filesystem-safe names to real bucket names
├── my-documents/                   # Bucket (filesystem-safe name)
│   ├── bucket.json                 # Bucket metadata (name, creation date, policy, etc)
│   ├── objects/
│   │   ├── README.md/              # Object directory (actual nested folder structure)
│   │   │   ├── versions.json       # Array of version records
│   │   │   └── v1/                 # Version directory (sequential: v1, v2, v3...)
│   │   │       ├── metadata.json   # Version-specific metadata
│   │   │       └── content.md      # Content file with extension matching ContentType
│   │   ├── logs/                   # Nested pseudo-directory
│   │   │   ├── 2024-11-11.log/     # Object in nested path
│   │   │   │   ├── versions.json
│   │   │   │   └── v1/
│   │   │   │       ├── metadata.json
│   │   │   │       └── content.log
│   │   │   └── 2024-11-10.log/     # Another object in same path
│   │   │       ├── versions.json   # Has 2 versions
│   │   │       ├── v1/
│   │   │       │   ├── metadata.json
│   │   │       │   └── content.log
│   │   │       └── v2/
│   │   │           ├── metadata.json
│   │   │           └── content.log
│   │   └── data/                   # Another pseudo-directory
│   │       └── config.json/        # Object with dotted name
│   │           ├── versions.json
│   │           └── v1/
│   │               ├── metadata.json
│   │               └── content.json
```

## Key Design Features

### 1. **Nested Folder Structure (No URL Encoding)**

**Problem Solved:** Previously, S3 keys with slashes were URL-encoded in the filesystem (e.g., `logs%2F2024-11-11.log`), making paths hard to read and navigate.

**Solution:** Use actual nested folders that mirror S3's pseudo-directory structure.

**Example:**
- S3 Key: `logs/2024-11-11.log`
- Filesystem: `objects/logs/2024-11-11.log/` (actual nested directories)
- In VS Code: You can open `logs/` folder and see `2024-11-11.log/` as a subdirectory

**Implementation Details:**
- When storing an object with key `logs/2024-11-11.log`, split the key by `/` and create directories for each component
- `path.join()` handles this correctly on all platforms (Windows uses `\`, Unix uses `/`)
- Intermediate folders (like `logs/`) only exist to organize objects; they're not "directories" in S3 terms
- To find all objects, recursively walk the tree and check for `versions.json`

### 2. **Content File Extensions**

**Problem Solved:** Content files had no extension, so VS Code didn't recognize them for syntax highlighting.

**Solution:** Map the `ContentType` field to an appropriate file extension, then use that when writing content.

**Content Type → Extension Mapping:**
```
application/json          → .json
text/plain                → .txt (unless ContentType is text/log → .log)
text/markdown             → .md
text/log                  → .log
text/xml                  → .xml
text/css                  → .css
text/javascript           → .js
application/xml           → .xml
application/javascript    → .js
image/*                   → .bin (binary)
application/octet-stream  → .bin
(unknown)                 → .bin
```

**Examples:**
- Object with `ContentType: "text/markdown"` → `content.md` (VS Code syntax highlights it as Markdown)
- Object with `ContentType: "application/json"` → `content.json` (VS Code formats and highlights JSON)
- Object with `ContentType: "text/log"` → `content.log` (Custom format)
- Object with unknown type → `content.bin` (Treated as binary)

**How It Works:**
1. When you call `PutObject`, pass `ContentType` in metadata
2. `storage.ts` derives the extension from `ContentType` via `getContentExtension()`
3. Content file is written as `v{n}/content{extension}` (e.g., `v1/content.json`)
4. When retrieving the object, `storage.ts` finds the content file by searching for `content.*`

### 3. **Bucket Name Sanitization**

**Problem Solved:** Real AWS bucket names can contain characters not safe for filesystems (dots, underscores, etc.), and different OS have different restrictions (Windows doesn't like certain chars, macOS is more permissive).

**Solution:** Maintain a mapping file (`buckets.json`) at the account level.

**How It Works:**
1. When you create a bucket named `my.bucket.com`, `storage.ts` sanitizes it to `my-bucket-com` (lowercase, replace unsafe chars with hyphens)
2. The directory is created as `my-bucket-com/`
3. Mapping is stored in `buckets.json`:
   ```json
   {
     "my-bucket-com": "my.bucket.com",
     "my_bucket": "my_bucket"
   }
   ```
4. When listing buckets, `storage.ts` reads `buckets.json` and uses the real bucket names in the API response
5. When looking up a bucket, it sanitizes the requested name and checks if the directory exists

**Sanitization Rules:**
- Convert to lowercase
- Replace spaces, dots, underscores, and other non-alphanumeric chars (except hyphens) with hyphens
- Remove leading/trailing hyphens
- Keep hyphens (they're safe on all filesystems)

### 4. **Simplified Version IDs**

**Problem Solved:** Version IDs were long and included timestamps (`v1704891930000-a1b2c3d4`), making them hard to read and unnecessary for a simulator.

**Solution:** Use simple sequential version IDs: `v1`, `v2`, `v3`, etc.

**How It Works:**
1. Each object has a `versions.json` file tracking the version history
2. When you put a new version, `storage.ts`:
   - Reads `versions.json`
   - Finds the highest version number (e.g., v2)
   - Creates the next version (v3)
   - Appends a new record to `versions.json`
3. Version directories are simple: `v1/`, `v2/`, `v3/`, etc.

**Example `versions.json`:**
```json
[
  {
    "versionId": "v1",
    "isLatest": false,
    "LastModified": "2024-11-10T09:15:00.000Z"
  },
  {
    "versionId": "v2",
    "isLatest": true,
    "LastModified": "2024-11-10T14:05:00.000Z"
  }
]
```

**Why Not Store Timestamps Separately?**
- Each version's `LastModified` is stored in its `metadata.json`
- No need to embed it in the version ID
- Cleaner, more readable IDs

## Metadata Structure

### `bucket.json` (Bucket Metadata)

```json
{
  "BucketName": "my-documents",
  "CreationDate": "2024-11-11T10:00:00.000Z",
  "Region": "us-east-1",
  "Arn": "arn:aws:s3:::my-documents",
  "Tags": [],
  "Policy": {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": { "AWS": "arn:aws:iam::123456789012:role/lambda-executor" },
        "Action": ["s3:GetObject", "s3:ListBucket"],
        "Resource": ["arn:aws:s3:::my-documents", "arn:aws:s3:::my-documents/*"]
      }
    ]
  }
}
```

### `versions.json` (Version History)

```json
[
  {
    "versionId": "v1",
    "isLatest": false,
    "LastModified": "2024-11-10T09:15:00.000Z"
  },
  {
    "versionId": "v2",
    "isLatest": true,
    "LastModified": "2024-11-10T14:05:00.000Z"
  }
]
```

### `v{n}/metadata.json` (Version-Specific Metadata)

```json
{
  "versionId": "v2",
  "LastModified": "2024-11-10T14:05:00.000Z",
  "ContentType": "text/plain",
  "ContentLength": 289,
  "StorageClass": "STANDARD",
  "ETag": "def456ghi789",
  "Metadata": {}
}
```

### `v{n}/content{extension}` (Object Content)

The actual object content, with extension derived from `ContentType`:
- `content.json` for JSON
- `content.log` for logs
- `content.md` for Markdown
- `content.txt` for plain text
- `content.bin` for binary

## Working with the Storage

### Adding an Object via the API

```bash
curl -X PUT http://localhost:3000/api/s3 \
  -H "Content-Type: application/json" \
  -d '{
    "action": "PutObject",
    "bucket": "my-documents",
    "key": "logs/2024-11-12.log",
    "contentType": "text/log",
    "body": "2024-11-12T08:00:00Z INFO Service started"
  }'
```

**What happens:**
1. `storage.ts` creates `objects/logs/2024-11-12.log/` if it doesn't exist
2. Reads `versions.json` (or creates if missing)
3. Finds next version (v1 if new, v3 if existing object with v2)
4. Creates `v{n}/` directory
5. Derives extension from `ContentType: "text/log"` → `.log`
6. Writes `v{n}/content.log` with object body
7. Writes `v{n}/metadata.json` with metadata
8. Updates `versions.json` to mark new version as latest

**Result on disk:**
```
objects/logs/2024-11-12.log/
├── versions.json
└── v1/
    ├── metadata.json
    └── content.log  ← VS Code recognizes this as a log file
```

### Retrieving an Object

```bash
curl http://localhost:3000/api/s3?action=GetObject&bucket=my-documents&key=logs/2024-11-12.log
```

**What happens:**
1. `storage.ts` constructs path: `objects/logs/2024-11-12.log/`
2. Reads `versions.json` to find latest version (v1)
3. Reads `v1/metadata.json` to get metadata
4. Searches `v1/` for `content.*` file (finds `content.log`)
5. Reads `content.log` and returns as response body

### Listing Objects with Prefix

```bash
curl http://localhost:3000/api/s3?action=ListObjects&bucket=my-documents&prefix=logs/
```

**What happens:**
1. `storage.ts` walks `objects/logs/` recursively
2. For each directory, checks if `versions.json` exists (indicates it's an object)
3. Reads `versions.json` to get latest version and metadata
4. Returns all objects found, filtering by prefix

**Objects found:**
```
- logs/2024-11-11.log
- logs/2024-11-10.log
- logs/2024-11-12.log
```

## Inspecting State in VS Code

Open the folder `/data/accounts/123456789012/s3/` in VS Code:

1. Expand `my-documents/` → `objects/` → see nested folders
2. Expand `logs/` → see date-based log files
3. Expand `2024-11-11.log/` → see `versions.json` and `v1/`, `v2/`, etc.
4. Open `v1/content.log` → VS Code syntax-highlights it as a log file
5. Open `v1/metadata.json` → VS Code formats it with proper JSON indentation

**Example Screenshot (Conceptual):**
```
📁 my-documents
  📄 bucket.json
  📁 objects
    📄 README.md
    📁 v1
      📄 content.md ← Click to read in editor
      📄 metadata.json
    📁 logs
      📁 2024-11-11.log
        📄 versions.json ← Lists [v1, v2, ...]
        📁 v1
          📄 content.log ← Syntax-highlighted log
          📄 metadata.json
        📁 v2
          📄 content.log
          📄 metadata.json
      📁 2024-11-10.log
    📁 data
      📁 config.json
        📁 v1
          📄 content.json ← Formatted JSON
```

## Future Enhancements

1. **Lazy Initialization:** Don't create version directories until first put
2. **Compression:** Add `.gz` extension for compressed content
3. **Content Hashing:** Store SHA256 of content for integrity checks
4. **Cleanup:** Implement DeleteObject that marks versions as deleted
5. **Import/Export:** Tools to bulk-import from real S3 or export to JSON

## Troubleshooting

### Issue: "Bucket not found" but directory exists
- Check if bucket name contains special characters
- Verify `buckets.json` has the correct mapping
- Try listing all buckets to see the actual name

### Issue: Content file has no syntax highlighting
- Check the `ContentType` field in metadata
- Verify the mapping includes that type (see extension table above)
- Manually add `.md` extension if needed for testing

### Issue: ListObjects returns empty when objects exist
- Verify `versions.json` exists in object directory
- Check that `versions.json` has at least one version record
- Walk the tree with `find data/accounts/.../objects -name versions.json`

### Issue: Retrieving object returns wrong version
- Check `versions.json` for `"isLatest": true` marker
- Verify version directory exists (e.g., `v1/`, `v2/`)
- Check metadata file is present and valid JSON
