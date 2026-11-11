# Inspecting S3 State in the Simulator

This guide walks you through inspecting stored S3 objects in the data directory with the new improved structure.

## Quick Start: Open in VS Code

1. Open folder: `data/accounts/123456789012/s3/`
2. Expand `my-documents/` folder
3. Explore the structure

You should see:
```
📁 my-documents
  📄 bucket.json
  📁 objects
    📄 README.md                    ← README.md object (no folder because it's at root)
    📁 logs                         ← Pseudo-directory
    📁 data                         ← Pseudo-directory
```

## Example 1: Inspecting README.md (Root-Level Object)

This object is stored at the root level with no nested folders.

### Path in VS Code

```
my-documents/
  objects/
    README.md/
      versions.json
      v1/
        content.md          ← Click to view
        metadata.json
```

### Viewing the Content

1. Click on `README.md/` folder to expand
2. Click on `versions.json` to see version history:
   ```json
   [
     {
       "versionId": "v1",
       "isLatest": true,
       "LastModified": "2024-11-11T10:00:00.000Z"
     }
   ]
   ```
3. Click on `v1/content.md` to read the Markdown file in VS Code editor
   - VS Code recognizes `.md` extension and renders it nicely

## Example 2: Inspecting Nested Objects (logs/2024-11-11.log)

This object is in a nested path, demonstrating the pseudo-directory structure.

### Path in VS Code

```
my-documents/
  objects/
    logs/                            ← Pseudo-directory (no files here)
      2024-11-11.log/                ← Object directory
        versions.json                ← Single version
        v1/
          content.log       ← Click to view
          metadata.json
```

### Viewing the Content

1. Expand `logs/` folder
2. Expand `2024-11-11.log/` folder
3. Click `versions.json` to see:
   ```json
   [
     {
       "versionId": "v1",
       "isLatest": true,
       "LastModified": "2024-11-11T14:30:00.000Z"
     }
   ]
   ```
4. Expand `v1/` folder
5. Click `content.log` to view log file (VS Code syntax-highlights log format)
6. Click `metadata.json` to see:
   ```json
   {
     "versionId": "v1",
     "LastModified": "2024-11-11T14:30:00.000Z",
     "ContentType": "text/plain",
     "ContentLength": 156,
     "StorageClass": "STANDARD",
     "ETag": "abc123def456"
   }
   ```

## Example 3: Inspecting Objects with Multiple Versions (logs/2024-11-10.log)

This object demonstrates versioning with two versions.

### Path in VS Code

```
my-documents/
  objects/
    logs/
      2024-11-10.log/              ← Object directory
        versions.json              ← TWO versions
        v1/                        ← First version (outdated)
          content.log
          metadata.json
        v2/                        ← Latest version
          content.log
          metadata.json
```

### Understanding Versions

1. Click `versions.json` to see both versions:
   ```json
   [
     {
       "versionId": "v1",
       "isLatest": false,                          ← Not latest
       "LastModified": "2024-11-10T09:15:00.000Z"
     },
     {
       "versionId": "v2",
       "isLatest": true,                           ← This is latest
       "LastModified": "2024-11-10T14:05:00.000Z"
     }
   ]
   ```

### Comparing Versions

1. Click `v1/content.log` - older content (4 lines):
   ```
   2024-11-10T09:15:00Z INFO Server started on port 3000
   2024-11-10T09:16:22Z INFO Connected to database successfully
   2024-11-10T10:45:30Z WARN Memory usage at 85%
   2024-11-10T11:00:00Z INFO Garbage collection completed
   ```

2. Click `v2/content.log` - updated content (6 lines):
   ```
   2024-11-10T09:15:00Z INFO Server started on port 3000
   2024-11-10T09:16:22Z INFO Connected to database successfully
   2024-11-10T10:45:30Z WARN Memory usage at 85%
   2024-11-10T11:00:00Z INFO Garbage collection completed
   2024-11-10T14:00:00Z ERROR Unhandled promise rejection
   2024-11-10T14:05:00Z INFO Process restarted automatically
   ```

3. Compare `v1/metadata.json` vs `v2/metadata.json`:
   - `v1` has `"ContentLength": 189`
   - `v2` has `"ContentLength": 289` (larger due to 2 additional log lines)

## Example 4: JSON Configuration File (data/config.json)

This demonstrates content file extensions for different MIME types.

### Path in VS Code

```
my-documents/
  objects/
    data/                            ← Pseudo-directory
      config.json/                   ← Object directory
        versions.json
        v1/
          content.json       ← Click to view (formatted JSON)
          metadata.json
```

### Viewing JSON Content

1. Click `v1/content.json` to view:
   ```json
   {
     "environment": "development",
     "debugMode": true,
     "maxConnections": 100,
     "logLevel": "debug",
     "timeout": 30000
   }
   ```
   - VS Code recognizes `.json` extension and provides syntax highlighting and auto-formatting

2. Click `metadata.json` to see:
   ```json
   {
     "versionId": "v1",
     "LastModified": "2024-11-11T10:20:00.000Z",
     "ContentType": "application/json",   ← Maps to .json extension
     "ContentLength": 142,
     "StorageClass": "STANDARD",
     "ETag": "config789def456"
   }
   ```

## Understanding File Extensions

The new storage system uses file extensions to help VS Code recognize and highlight content:

| ContentType | Extension | Example |
|---|---|---|
| `application/json` | `.json` | `content.json` ← VS Code formats & highlights |
| `text/markdown` | `.md` | `content.md` ← Markdown rendering |
| `text/plain` | `.txt` | `content.txt` ← Plain text |
| `text/log` | `.log` | `content.log` ← Log-specific coloring |
| `text/xml` | `.xml` | `content.xml` ← XML syntax highlighting |
| `image/*` | `.bin` | `content.bin` ← Binary (shown as hex) |
| unknown | `.bin` | `content.bin` ← Binary fallback |

## Understanding Bucket Name Sanitization

The `buckets.json` file at `s3/` root maps filesystem-safe names to real bucket names:

```json
{
  "my-documents": "my-documents"
}
```

**Example:** If you created a bucket named `my.bucket.com`:
1. Sanitized to: `my-bucket-com` (for filesystem)
2. Directory created: `my-bucket-com/`
3. Mapping stored: `{"my-bucket-com": "my.bucket.com"}`
4. API returns real name: `my.bucket.com` (from mapping)

## Command Line Inspection

### List All Objects in Bucket

```bash
find data/accounts/123456789012/s3/my-documents/objects -name versions.json
```

Output:
```
data/accounts/123456789012/s3/my-documents/objects/README.md/versions.json
data/accounts/123456789012/s3/my-documents/objects/logs/2024-11-11.log/versions.json
data/accounts/123456789012/s3/my-documents/objects/logs/2024-11-10.log/versions.json
data/accounts/123456789012/s3/my-documents/objects/data/config.json/versions.json
```

### View Version History for One Object

```bash
cat data/accounts/123456789012/s3/my-documents/objects/logs/2024-11-10.log/versions.json | jq .
```

Output:
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

### View Latest Version Metadata

```bash
cat data/accounts/123456789012/s3/my-documents/objects/logs/2024-11-10.log/v2/metadata.json | jq .
```

Output:
```json
{
  "versionId": "v2",
  "LastModified": "2024-11-10T14:05:00.000Z",
  "ContentType": "text/plain",
  "ContentLength": 289,
  "StorageClass": "STANDARD",
  "ETag": "def456ghi789"
}
```

### View Content File

```bash
cat data/accounts/123456789012/s3/my-documents/objects/logs/2024-11-10.log/v2/content.log
```

Output:
```
2024-11-10T09:15:00Z INFO Server started on port 3000
2024-11-10T09:16:22Z INFO Connected to database successfully
2024-11-10T10:45:30Z WARN Memory usage at 85%
2024-11-10T11:00:00Z INFO Garbage collection completed
2024-11-10T14:00:00Z ERROR Unhandled promise rejection
2024-11-10T14:05:00Z INFO Process restarted automatically
```

### Count Objects by Pseudo-Directory

```bash
find data/accounts/123456789012/s3/my-documents/objects -name versions.json | xargs dirname | xargs dirname | sort | uniq -c
```

## Key Differences from Old Structure

### Old Structure (No Longer Used)
```
objects/logs%2F2024-11-11.log/        ← URL-encoded slash
  v1704891930000-a1b2c3d4/            ← Long timestamp-based ID
    content                           ← No extension
    metadata.json
```

### New Structure (Current)
```
objects/logs/2024-11-11.log/          ← Real nested folders
  v1/                                 ← Simple sequential ID
    content.log                       ← Extension for VS Code highlighting
    metadata.json
```

**Benefits:**
- Much more readable in VS Code file explorer
- VS Code can syntax-highlight content files
- Simple version IDs (`v1`, `v2`) instead of long timestamps
- No URL encoding makes navigation intuitive

## Troubleshooting

### Content file shows as "content.*" instead of specific extension

Check the `metadata.json` file:
- Verify `ContentType` field is set correctly
- If unknown type, it defaults to `content.bin`
- Supported types: `application/json`, `text/markdown`, `text/log`, etc.

### Can't find an object you uploaded

Check that `versions.json` exists in the object directory:
```bash
find data/accounts/123456789012/s3 -type f -name versions.json
```

If missing, the object might be stored in a different bucket or prefix.

### Version not marked as latest

Open `versions.json` and check `"isLatest": true`:
```bash
cat data/accounts/123456789012/s3/my-documents/objects/logs/2024-11-10.log/versions.json | jq '.[].isLatest'
```

Should show `false` for v1 and `true` for v2.

### Metadata and content files don't match

Verify the version directory exists and both files are present:
```bash
ls -la data/accounts/123456789012/s3/my-documents/objects/logs/2024-11-11.log/v1/
```

Should show:
- `metadata.json`
- `content.log` (or another extension based on ContentType)
