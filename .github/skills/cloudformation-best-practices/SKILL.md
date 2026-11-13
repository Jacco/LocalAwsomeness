---
name: CloudFormation Best Practices & Debugging
description: >
  Use when: implementing CloudFormation features, debugging CloudFormation errors, 
  working on storage/persistence issues, testing CloudFormation operations, or 
  migrating to file-based storage. Encodes lessons learned from multi-hour debugging 
  session that discovered critical testing methodology flaws and storage persistence issues.
keywords:
  - cloudformation
  - testing
  - storage
  - persistence
  - debugging
  - module initialization
  - aws cli
  - data verification
---

# CloudFormation Best Practices & Debugging Guide

## 🚨 Critical Lessons from Session Debugging

This skill captures systemic improvements needed after a 3-hour debugging session where:
- CloudFormation CreateStack failed with "path argument must be of type string"
- Testing with curl masked real problems for 3 hours
- Storage was completely in-memory but API responses looked successful
- No data appeared in the filesystem despite successful API calls

## Testing Protocol - NEVER DO THESE AGAIN ❌

### ❌ NEVER USE CURL
```bash
# DON'T DO THIS - curl doesn't validate AWS protocol
curl -X POST http://localhost:3000/api/cloudformation \
  -H "Content-Type: application/json" \
  -d '{"Action": "CreateStack"}'
```

**Why curl is wrong:**
- Doesn't validate AWS request/response protocol
- Doesn't check authentication/authorization
- HTTP 200 response hides real errors (protocol errors returned as ValidationException)
- Can't verify data persistence (file writes don't affect HTTP response)
- 3 hours of curl testing revealed nothing; 5 minutes with AWS CLI revealed everything

### ✅ ALWAYS USE REAL AWS TOOLS

**For simple operations - AWS CLI:**
```bash
# CreateStack with file-based template
aws cloudformation create-stack \
  --endpoint-url http://localhost:3000 \
  --stack-name my-test-stack \
  --template-body file://template.json

# Verify files were written to disk
ls -la data/accounts/123456789012/cloudformation/stacks/
cat data/accounts/123456789012/cloudformation/stacks/my-test-stack.json

# Describe stack to verify data persistence
aws cloudformation describe-stacks \
  --endpoint-url http://localhost:3000 \
  --stack-name my-test-stack
```

**For complex scenarios - boto3:**
```python
import boto3

cf = boto3.client('cloudformation', endpoint_url='http://localhost:3000')
cf.create_stack(StackName='test', TemplateBody=json.dumps(template))
```

**For infrastructure testing - Terraform:**
```terraform
provider "aws" {
  endpoint = "http://localhost:3000"
}

resource "aws_cloudformation_stack" "test" {
  name = "test-stack"
  template_body = file("template.json")
}
```

## Data Persistence Verification Checklist ✓

**After every CloudFormation operation, verify:**

1. **Check filesystem first**
   ```bash
   # Before checking API
   ls -la data/accounts/123456789012/cloudformation/stacks/
   cat data/accounts/123456789012/cloudformation/stacks/stack-name.json
   ```

2. **Don't assume API response means data was saved**
   - HTTP 200 is not proof of persistence
   - Check actual files on disk
   - Verify file content is valid JSON
   - Parse and validate the stored data

3. **Test restart/recovery cycle**
   ```bash
   # After server restart, verify data still exists
   # Kill and restart npm run dev
   ls -la data/accounts/123456789012/cloudformation/stacks/
   aws cloudformation describe-stacks --endpoint-url http://localhost:3000
   ```

4. **Verify cross-account isolation**
   ```bash
   # Confirm data is in account-specific directory
   data/accounts/
   ├── 123456789012/
   │   └── cloudformation/
   │       ├── stacks/
   │       └── templates/
   ├── 390209512651/
   │   └── cloudformation/
   └── ...
   ```

## Module Initialization Pattern - ALWAYS USE THIS 🔒

**Problem:** Module-level `process.cwd()` calls fail during Next.js server startup

**Solution:** Wrap ALL module-level path operations in safe functions

```typescript
// ❌ WRONG - fails if process.cwd() is unavailable
const dataPath = path.join(process.cwd(), 'data')

// ✅ CORRECT - safe with fallback
const SAFE_PATH = (() => {
  try {
    const env = process.env.JPK_DB_ROOT
    if (env && typeof env === 'string') return env
    
    const cwd = process.cwd()
    if (!cwd || typeof cwd !== 'string') return '/tmp/jpk-db'
    
    return path.join(cwd, 'data')
  } catch (e) {
    console.error('Failed to initialize data path:', e)
    return '/tmp/jpk-db'
  }
})()
```

**Checklist for module-level initialization:**
- ✓ Wrap in try-catch block
- ✓ Check for undefined values with guard clauses
- ✓ Verify types before using (typeof check)
- ✓ Provide fallback value
- ✓ Log errors for debugging
- ✓ Move to IIFE to prevent re-execution

## Server Management Protocol 📋

**BEFORE restarting dev server:**

1. **Ask the user first**
   ```
   "I need to restart the dev server to test this change. 
    Can you run 'npm run dev' when you're ready?"
   ```

2. **Don't kill processes without permission**
   - User maintains one running `npm run dev`
   - Dev server auto-reloads on file changes
   - Manual restarts lose context and frustrate user

3. **Leverage auto-reload**
   ```bash
   # DON'T DO:
   # Kill process, wait for restart, test again

   # DO THIS:
   # Edit code
   # Dev server auto-reloads
   # Test again immediately
   ```

**When testing changes:**
- Keep one terminal running `npm run dev`
- Make code changes in another terminal
- Dev server reloads automatically (usually <3 seconds)
- Test immediately after reload

## Common Pitfalls & How We Fixed Them 🐛

### Pitfall 1: In-Memory Storage Without Persistence

**Symptom:** API returns success, but no files appear in data directory

**Root Cause:** Implementation used `new Map<string, Stack>()` without file writes

**How it looked:**
```typescript
// ❌ WRONG - in-memory only
const stacks = new Map<string, Stack>()
const templates = new Map<string, string>()

export function createStack(stackId: string, stack: Stack) {
  stacks.set(stackId, stack)  // <- Data lost on restart!
}
```

**Fix:**
```typescript
// ✅ CORRECT - file-based with proper directory structure
export async function createStack(accountId: string, stackId: string, stack: Stack) {
  const stackDir = path.join(getDataPath(), 'accounts', accountId, 'cloudformation', 'stacks')
  await fs.mkdir(stackDir, { recursive: true })
  await fs.writeFile(
    path.join(stackDir, `${stackId}.json`),
    JSON.stringify(stack, null, 2)
  )
}
```

### Pitfall 2: Module-Level path.join() Failures

**Symptom:** "path argument must be of type string. Received undefined"

**Root Cause:** `process.cwd()` called at module load time when not available

**Three files affected:**
- `src/app/api/s3/resources/route.ts:5`
- `src/app/api/s3/resources/buckets/[bucket]/route.ts:5`
- `src/app/api/lambda/invoke.ts:25`

**Fix Applied:**
```typescript
// Move to function-level with safe wrapper
function getDataPath(): string {
  try {
    const env = process.env.JPK_DB_ROOT
    if (env && typeof env === 'string') return env
    const cwd = process.cwd()
    if (!cwd || typeof cwd !== 'string') return '/tmp/jpk-db'
    return cwd
  } catch (e) {
    console.error('Path initialization failed:', e)
    return '/tmp/jpk-db'
  }
}

// Use in GET handler
const dataPath = path.join(getDataPath(), 'data')
```

### Pitfall 3: Can't See Errors in HTTP Responses

**Symptom:** Protocol handler catches exceptions, returns ValidationException

**Result:** Actual module-level error never visible in curl response

**Why it matters:** curl response status 200 but operation failed silently

**How AWS CLI helps:** boto3/AWS CLI validates protocol, shows real errors

## Storage Implementation Template 📁

**Expected directory structure for file-based storage:**

```
data/
└── accounts/
    ├── 123456789012/
    │   └── cloudformation/
    │       ├── stacks/
    │       │   ├── stack-1.json      # Stack definition
    │       │   ├── stack-2.json
    │       │   └── ...
    │       └── templates/
    │           ├── template-1.v1.json  # Template versions
    │           ├── template-1.v2.json
    │           └── ...
    └── 390209512651/
        └── cloudformation/
            ├── stacks/
            └── templates/
```

**Stack file format:**
```json
{
  "StackId": "arn:aws:cloudformation:us-east-1:123456789012:stack/my-stack/uuid",
  "StackName": "my-stack",
  "StackStatus": "CREATE_COMPLETE",
  "CreationTime": "2026-11-13T07:00:00Z",
  "TemplateDescription": "Test template",
  "Parameters": {},
  "Outputs": {},
  "Resources": {}
}
```

## Testing Workflow 🧪

### Phase 1: Create & Verify Persistence
```bash
# Start dev server with auto-reload
npm run dev

# In another terminal, create stack
aws cloudformation create-stack \
  --endpoint-url http://localhost:3000 \
  --stack-name test-stack-1 \
  --template-body file://template.json

# Verify files written to disk BEFORE checking API
ls -la data/accounts/123456789012/cloudformation/stacks/
cat data/accounts/123456789012/cloudformation/stacks/test-stack-1.json

# Verify API response
aws cloudformation describe-stacks \
  --endpoint-url http://localhost:3000 \
  --stack-name test-stack-1
```

### Phase 2: Test Restart Recovery
```bash
# Stop dev server (Ctrl+C)
# Verify files still exist on disk
ls -la data/accounts/123456789012/cloudformation/stacks/

# Restart dev server
npm run dev

# Verify stack still accessible via API
aws cloudformation describe-stacks \
  --endpoint-url http://localhost:3000 \
  --stack-name test-stack-1

# Verify file content matches API response
cat data/accounts/123456789012/cloudformation/stacks/test-stack-1.json
```

### Phase 3: Multi-Account Isolation
```bash
# Create stack in account A
AWS_ACCOUNT_ID=123456789012 aws cloudformation create-stack \
  --endpoint-url http://localhost:3000 \
  --stack-name stack-in-a \
  --template-body file://template.json

# Create stack in account B
AWS_ACCOUNT_ID=390209512651 aws cloudformation create-stack \
  --endpoint-url http://localhost:3000 \
  --stack-name stack-in-b \
  --template-body file://template.json

# Verify account isolation
ls -la data/accounts/123456789012/cloudformation/stacks/
ls -la data/accounts/390209512651/cloudformation/stacks/
```

## Debugging Checklist 🔍

When CloudFormation operations fail:

1. **Check file system first** (not API response)
   ```bash
   ls -la data/accounts/*/cloudformation/
   ```

2. **Verify dev server logs** (in npm run dev terminal)
   - Look for stack traces
   - Check initialization errors
   - Verify no module-level errors

3. **Check module initialization** (in source code)
   - Grep for module-level `path.join(process.cwd())`
   - Look for unsafe file operations
   - Verify try-catch wrappers

4. **Test with AWS CLI** (not curl)
   ```bash
   aws cloudformation create-stack --endpoint-url http://localhost:3000 ...
   ```

5. **Verify file format** (not just presence)
   ```bash
   cat data/accounts/123456789012/cloudformation/stacks/stack-name.json | jq .
   ```

6. **Check account isolation**
   - Confirm account ID matches request headers
   - Verify files in correct account directory
   - Check `getRequestInfo()` returns correct account

## References

- **Session Documentation**: `SESSION-LESSONS.md` (full summary)
- **Detailed Post-Mortem**: `debugging-lessons-learned.md` (in session files)
- **Best Practices**: `best-practices-updated.md` (in session files)
- **Phase 4.1a Plan**: `next-phase-plan.md` (implementation details)

## Key Metrics from Debugging Session

| Metric | Value | Lesson |
|--------|-------|--------|
| Time testing with curl | 180 minutes | Wrong tool hides real issues |
| Time using AWS CLI | 5 minutes | Right tool reveals everything |
| Stacks created (appeared in API) | 6 | API responses were misleading |
| Files written to disk | 0 | In-memory storage was invisible to API |
| Module-level errors fixed | 3 | Critical initialization issues |
| Sessions lost to restarts | 2 | Communication prevents wasted time |

---

**Last Updated:** 2026-11-13  
**Trigger This Skill When:** Working on CloudFormation features, debugging CF errors, implementing storage, or testing CF operations
