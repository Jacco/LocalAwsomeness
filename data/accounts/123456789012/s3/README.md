# S3 Simulator Storage

This directory contains the persistent storage for the AWS Lambda simulator's S3 implementation.

## Quick Navigation

- **[FILE_STORAGE_GUIDE.md](FILE_STORAGE_GUIDE.md)** - Complete technical guide to the storage structure and implementation
- **[INSPECT_STATE.md](INSPECT_STATE.md)** - Step-by-step guide to inspecting stored objects in VS Code

## What's Here

```
.
├── buckets.json                     # Mapping of bucket names (filesystem-safe → real names)
├── my-documents/                    # Example bucket
│   ├── bucket.json                  # Bucket metadata
│   └── objects/
│       ├── README.md/               # Example object (root level)
│       ├── logs/                    # Pseudo-directory
│       │   ├── 2024-11-11.log/      # Object with 1 version
│       │   └── 2024-11-10.log/      # Object with 2 versions (v1, v2)
│       └── data/
│           └── config.json/         # JSON object
```

## Four Key Improvements

### 1. 📁 Nested Folder Structure (No URL Encoding)

**Before:** `objects/logs%2F2024-11-11.log/` ← ugly URL encoding

**After:** `objects/logs/2024-11-11.log/` ← natural nested folders

Paths are readable in VS Code file explorer and match S3's pseudo-directory structure.

### 2. 🎨 Content File Extensions

**Before:** `content` ← no syntax highlighting

**After:** `content.log`, `content.json`, `content.md` ← VS Code recognizes and highlights

Extensions are derived from `ContentType`, so JSON files show formatted JSON, logs show color-coded log entries, Markdown renders nicely.

### 3. 🏷️ Simplified Version IDs

**Before:** `v1704891930000-a1b2c3d4` ← long timestamp + random

**After:** `v1`, `v2`, `v3` ← simple sequential

Much cleaner and easier to read. Timestamps are stored in metadata files.

### 4. 🔒 Bucket Name Sanitization

**Before:** Direct filesystem names (risky if bucket has dots, underscores)

**After:** `buckets.json` mapping (filesystem-safe → real bucket names)

Handles bucket names like `my.bucket.com` safely on all operating systems.

## Example Objects

### README.md (Root-level Markdown)

```
README.md/
├── versions.json        [1 version]
└── v1/
    ├── content.md       ← Markdown syntax highlighting
    └── metadata.json
```

### logs/2024-11-10.log (Multi-versioned Log)

```
logs/2024-11-10.log/
├── versions.json        [2 versions: v1 (old), v2 (latest)]
├── v1/
│   ├── content.log      ← 4 log lines
│   └── metadata.json    [ContentLength: 189]
└── v2/
    ├── content.log      ← 6 log lines (updated)
    └── metadata.json    [ContentLength: 289]
```

### data/config.json (JSON Object)

```
data/config.json/
├── versions.json        [1 version]
└── v1/
    ├── content.json     ← Formatted JSON
    └── metadata.json
```

## Working with Storage

### Add a New Object

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

Result: `objects/logs/2024-11-12.log/v1/content.log` created with `.log` extension.

### Retrieve an Object

```bash
curl http://localhost:3000/api/s3?action=GetObject&bucket=my-documents&key=logs/2024-11-11.log
```

Returns latest version content + metadata.

### List Objects

```bash
curl http://localhost:3000/api/s3?action=ListObjects&bucket=my-documents&prefix=logs/
```

Returns all objects in `logs/` prefix.

## Inspecting State

### In VS Code

1. Open folder: `data/accounts/123456789012/s3/`
2. Expand `my-documents/` → `objects/`
3. Click on any `versions.json` to see version history
4. Click on any `content.*` to view the object content with syntax highlighting
5. Click on `metadata.json` to see object metadata

### From Command Line

```bash
# List all objects
find data/accounts/123456789012/s3/my-documents/objects -name versions.json

# View specific object's versions
cat data/accounts/123456789012/s3/my-documents/objects/logs/2024-11-10.log/versions.json | jq .

# View latest version content
cat data/accounts/123456789012/s3/my-documents/objects/logs/2024-11-10.log/v2/content.log

# View metadata
cat data/accounts/123456789012/s3/my-documents/objects/logs/2024-11-10.log/v2/metadata.json | jq .
```

## File Extension Mapping

| Content Type | Extension | Example |
|---|---|---|
| `application/json` | `.json` | Formatted JSON |
| `text/markdown` | `.md` | Markdown rendering |
| `text/plain` | `.txt` | Plain text |
| `text/log` | `.log` | Log highlighting |
| `text/xml` | `.xml` | XML syntax |
| `image/*` | `.bin` | Binary file |
| unknown | `.bin` | Binary fallback |

## Documentation

- **FILE_STORAGE_GUIDE.md** - Technical details, design decisions, implementation
- **INSPECT_STATE.md** - Step-by-step inspection examples with screenshots
- **README.md** - This file

## Questions?

See **FILE_STORAGE_GUIDE.md** for:
- Complete directory structure explanation
- Design decisions behind each improvement
- How storage operations work (PutObject, GetObject, ListObjects)
- Troubleshooting guide

See **INSPECT_STATE.md** for:
- Live examples of inspecting each object type
- Command-line inspection commands
- Comparing versions
- Understanding metadata
