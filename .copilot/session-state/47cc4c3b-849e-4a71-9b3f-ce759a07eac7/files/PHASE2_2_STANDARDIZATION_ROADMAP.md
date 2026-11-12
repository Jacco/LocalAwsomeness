# Phase 2.2: Service Implementation Standardization

**Status**: In Progress  
**Goal**: Ensure all 5 services follow consistent implementation patterns

---

## Current Analysis (Phase 2.1 Complete)

### Services Ready for Standardization

#### EC2 Service ✅ WELL-ORGANIZED
- **Location**: `src/app/api/ec2/`
- **Pattern**: ✅ Excellent - uses `defineService()` with explicit operation list
- **Files**: 19 TS files, well-organized by concern
- **State**: Uses `loadState()` / `saveState()` wrapper pattern
- **Error Handling**: Standardized through `operation()` wrapper
- **Status**: Minimal changes needed, primarily documentation complete

**Pattern Analysis**:
```typescript
// ✅ GOOD: Explicit operation list with wrappers
export const ec2 = defineService({
  iamPrefix: 'ec2',
  protocol: new Ec2Protocol(),
  operations: {
    CreateVpc: write(createVpcOp),
    DescribeVpcs: read(describeVpcsOp),
    // ...
  },
})

// ✅ GOOD: Wrapper pattern for state management
const read = (op: Op) => operation(op, false)
const write = (op: Op) => operation(op, true)
```

---

#### Lambda Service ⚠️ NEEDS CLEANUP
- **Location**: `src/app/api/lambda/`
- **Pattern**: Mixed - some operations in service.ts, versioned routes separate
- **Files**: 20 TS files + versioned route directories
- **State**: Separate from service logic
- **Issue**: Lambda versioned routes are separate from main service registry

**Pattern Analysis**:
```typescript
// ⚠️ ISSUE: Operation registry in service.ts
export const lambda = defineService({
  operations: {
    CreateFunction: { handler: createFunction, action: 'lambda:CreateFunction' },
    // ... 
  },
})

// ⚠️ ISSUE: Versioned routes are separate files, not in registry
// src/app/api/lambda/2015-03-31/functions/route.ts
// src/app/api/lambda/2017-03-31/tags/route.ts
// These routes need to be connected to service registry
```

**Standardization Work**:
- [ ] Ensure all versioned routes import from main service
- [ ] Document versioning strategy
- [ ] Create version router pattern

---

#### IAM Service ⚠️ NEEDS REFACTORING
- **Location**: `src/app/api/iam/`
- **Pattern**: Modular but slightly scattered - uses spread operators
- **Files**: 5 TS files (minimal, spread imports)
- **Issue**: Operation handlers imported from separate files and spread into registry

**Pattern Analysis**:
```typescript
// ⚠️ ISSUE: Spread operator pattern makes it hard to see all operations
export const iam = defineService({
  iamPrefix: 'iam',
  protocol: new QueryProtocol(IAM_NS, '2010-05-08'),
  operations: { ...roleHandlers, ...policyHandlers, ...userHandlers }
})

// Better: Explicit list
export const iam = defineService({
  iamPrefix: 'iam',
  protocol: new QueryProtocol(IAM_NS, '2010-05-08'),
  operations: {
    ...roleHandlers,
    ...policyHandlers,
    ...userHandlers,
  }
})
```

**Standardization Work**:
- [ ] Add comments explaining spread imports
- [ ] Create handlers index file for discoverability
- [ ] Document which operations come from which file

---

#### S3 Service ⚠️ NEEDS WRAPPER DOCUMENTATION
- **Location**: `src/app/api/s3/`
- **Pattern**: Uses custom `s3Operation()` wrapper for cross-account logic
- **Files**: 8 TS files
- **Issue**: Custom wrapper pattern needs documentation, not obvious it's intentional

**Pattern Analysis**:
```typescript
// ⚠️ ISSUE: Custom wrapper pattern not obvious
function s3Operation(op: Op): Handler {
  return ctx => {
    const scope = { account: ctx.account, region: ctx.region }
    const owner = bucketOwner(ctx)
    // Context switching logic
    const req: Req = {
      account: owner ?? ctx.account,  // ← Key: use bucket owner's account
      // ...
    }
    return op(storage, req)
  }
}

// How is this different from standard pattern? Documentation needed!
```

**Standardization Work**:
- [ ] Add comments explaining cross-account context switching
- [ ] Document why wrapper is needed vs. standard pattern
- [ ] Add example of operation flow

---

#### KMS Service ✅ WELL-ORGANIZED
- **Location**: `src/app/api/kms/`
- **Pattern**: ✅ Good - uses `defineService()` with explicit operations
- **Files**: 4 TS files, minimal and focused
- **State**: Uses `withKey()` wrapper pattern (similar to EC2's `operation()` wrapper)
- **Status**: Minimal changes needed, primarily documentation complete

**Pattern Analysis**:
```typescript
// ✅ GOOD: Explicit operations with resource handling
export const kms = defineService({
  iamPrefix: 'kms',
  protocol: new JsonProtocol('1.1'),
  operations: {
    CreateKey: ctx => { /* inline impl */ },
    DescribeKey: { 
      resources: keyResource, 
      handler: ctx => withKey(ctx, id => { /* impl */ })
    },
    // ...
  },
})
```

---

## Standardization Tasks

### Task 1: EC2 - Minor Updates
**Effort**: 30 min

- [ ] Add explicit comments to `operation()` wrapper explaining pattern
- [ ] Ensure consistent naming (all use `Op` type)
- [ ] Add "Handler Organization" section to service.ts header

**Changes**:
```typescript
// Before
function operation(op: Op, mutates: boolean): Handler {
  // ... implementation

// After  
// Standardized operation wrapper: loads state, validates region, executes operation,
// handles DryRun, saves state if mutated. Used by both read and write operations.
function operation(op: Op, mutates: boolean): Handler {
  // ... implementation
```

---

### Task 2: Lambda - Versioned Routes Refactoring
**Effort**: 1-2 hours

**Current Issue**: Versioned routes are defined separately, not connected to main service registry

**Solution Options**:

**Option A**: Keep routes separate, create version router in route.ts
```typescript
// src/app/api/lambda/route.ts - VERSION ROUTER PATTERN
import { lambda } from "./service"
import { handle2015_03_31 } from "./2015-03-31/handler"
import { handle2017_03_31 } from "./2017-03-31/handler"
import { handle2024_08_31 } from "./2024-08-31/handler"

export const POST = async (req) => {
  const version = extractVersionFromPath(req.url)
  const handler = getVersionHandler(version)
  return handler(req)
}
```

**Option B**: Register all operations in service.ts with version decorators
```typescript
export const lambda = defineService({
  operations: {
    // v2015-03-31
    CreateFunction: { version: '2015-03-31', handler: ... },
    ListFunctions: { version: '2015-03-31', handler: ... },
    // v2017-03-31
    ListTags: { version: '2017-03-31', handler: ... },
    // ...
  },
})
```

**Recommendation**: Option A (separate version handlers) - cleaner, matches Lambda's actual versioning

**Standardization Work**:
- [ ] Create version handler pattern in src/app/api/lambda/handler.ts
- [ ] Document versioning strategy in service.ts
- [ ] Ensure all versioned operations are discoverable

---

### Task 3: IAM - Spread Imports Documentation
**Effort**: 30 min

**Current**: Uses `{ ...roleHandlers, ...policyHandlers, ...userHandlers }`

**Standardization**: Add explicit comments and create handlers index

**Changes**:
```typescript
// Before
export const iam = defineService({
  operations: { ...roleHandlers, ...policyHandlers, ...userHandlers }
})

// After
// Operations are imported from separate handler modules for organization:
// - roleHandlers (roles.ts): CreateRole, DeleteRole, GetRole, ListRoles, etc.
// - policyHandlers (policies.ts): CreatePolicy, DeletePolicy, AttachUserPolicy, etc.
// - userHandlers (users.ts): CreateUser, DeleteUser, GetUser, ListUsers, etc.
export const iam = defineService({
  iamPrefix: 'iam',
  protocol: new QueryProtocol(IAM_NS, '2010-05-08'),
  operations: {
    ...roleHandlers,
    ...policyHandlers,
    ...userHandlers,
  }
})
```

**Standardization Work**:
- [ ] Create handlers.ts or handlers/index.ts listing all operations
- [ ] Add docstring to service.ts explaining the spread pattern
- [ ] Ensure good discoverability

---

### Task 4: S3 - Wrapper Pattern Documentation
**Effort**: 45 min

**Current**: Uses `s3Operation()` wrapper for cross-account bucket access logic

**Why Different**: S3 operations must work on bucket owner's storage, not caller's account storage

**Standardization**: Document the wrapper and context switching pattern

**Changes**:
```typescript
// Before
function s3Operation(op: Op): Handler {
  return ctx => {
    // ...
  }
}

// After
/**
 * S3 Operation Wrapper Pattern
 * 
 * S3 buckets are globally scoped but account-owned. When a principal from 
 * Account B accesses a bucket owned by Account A:
 * 
 * 1. Find bucket owner account (bucketOwner())
 * 2. Evaluate both caller's identity policies AND bucket's resource policy
 * 3. Execute operation in bucket owner's storage context
 * 4. Return result to caller
 * 
 * This is different from standard operation pattern because the operation
 * context (account) differs from the caller's account.
 * 
 * Example: User from Account B reads object in Account A's bucket
 * - Authorization: Check Account B policies + Account A bucket policy
 * - Execution: Run in Account A storage context
 */
function s3Operation(op: Op): Handler {
  return ctx => {
    // ...
  }
}
```

**Standardization Work**:
- [ ] Add comprehensive docstring explaining cross-account logic
- [ ] Add example flow diagram as comments
- [ ] Document bucketPolicy() and bucketOwner() functions
- [ ] Link to AWS documentation on cross-account S3 access

---

### Task 5: KMS - Minor Updates
**Effort**: 30 min

- [ ] Add explicit comments to `withKey()` wrapper explaining pattern
- [ ] Ensure error handling transformation is documented
- [ ] Consistency check with EC2's `operation()` wrapper

---

## Standardized Patterns Summary

### Pattern 1: State Wrapper (EC2, KMS)
```typescript
// Operation wrapper that handles state loading, validation, and saving
function operation(op: Op, mutates: boolean): Handler {
  return ctx => {
    // 1. Validate environment (region enabled, etc.)
    // 2. Load state
    // 3. Execute operation
    // 4. Check DryRun
    // 5. Save state if mutated
    // Return result
  }
}
```

### Pattern 2: Cross-Context Wrapper (S3)
```typescript
// Operation wrapper that switches execution context (account)
function s3Operation(op: Op): Handler {
  return ctx => {
    // 1. Determine target context (bucket owner)
    // 2. Validate caller has permission in source context
    // 3. Execute in target context
    // 4. Return result to caller
  }
}
```

### Pattern 3: Version Router (Lambda)
```typescript
// Route requests to version-specific handlers
function versionRouter(req, versions): Response {
  // 1. Extract version from path
  // 2. Look up handler for version
  // 3. Delegate to version-specific handler
  // 4. Return response
}
```

### Pattern 4: Modular Operations (IAM)
```typescript
// Organize operations by domain and spread into registry
const roleOps = { CreateRole, DeleteRole, ... }
const policyOps = { CreatePolicy, DeletePolicy, ... }

export const iam = defineService({
  operations: { ...roleOps, ...policyOps }
})
```

---

## Acceptance Criteria

✅ All 5 services follow one of the standardized patterns  
✅ Each wrapper/pattern is explicitly documented  
✅ Patterns are discoverable (good comments, clear names)  
✅ Build passes, tests pass  
✅ No functional changes (only documentation/comments)  

---

## Timeline

- **Phase 2.2**: Service implementation standardization (2-3 hours)
  - EC2: 30 min ✅
  - Lambda: 1-2 hours
  - IAM: 30 min
  - S3: 45 min
  - KMS: 30 min

- **Phase 2.3**: Terraform integration test framework (2-3 hours)

- **Phase 2.4**: Execute test suite (1-2 hours)

---

## Next Steps

1. Wait for analysis agent to complete
2. Review detailed service analysis
3. Execute standardization tasks in order (EC2, Lambda, IAM, S3, KMS)
4. Verify no functional changes with build/test
5. Commit each service as completed

