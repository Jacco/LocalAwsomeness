# Phase 2: Service Standardization Plan

**Status**: Ready to Execute  
**Created**: 2026-11-12  
**Scope**: Standardize EC2, Lambda, IAM, S3, KMS service implementations

---

## Current State Analysis

### Service Structure Inventory

| Service | Protocol | Pattern | Files | README |
|---------|----------|---------|-------|--------|
| **EC2** | REST/Query | `defineService()` | 19 TS files | ❌ No (has ec2.md) |
| **Lambda** | REST/JSON | `defineService()` | 20 TS files + versioned routes | ❌ No |
| **IAM** | Query | `defineService()` | 5 TS files | ❌ No |
| **S3** | REST/XML | `defineService()` + custom wrapper | 8 TS files | ❌ No |
| **KMS** | JSON 1.1 | `defineService()` | 4 TS files | ❌ No |

### Key Inconsistencies Identified

#### 1. **Operation Definition Pattern**
- **Lambda & KMS**: Use `defineService()` with `operations: { ... }` object
- **S3**: Uses `defineService()` + custom `s3Operation()` wrapper for context switching
- **IAM**: Uses `defineService()` with spread operators (`...roleHandlers`, `...policyHandlers`, etc.)
- **EC2**: Pattern unclear - needs investigation

**Goal**: Standardize on `defineService()` with consistent operation registration

#### 2. **Service Route Structure**
- **Lambda**: Versioned routes (`2015-03-31/`, `2017-03-31/`, `2019-09-30/`, `2024-08-31/`)
  - Uses `[name]` and `[arn]` dynamic segments
  - Plus top-level `/inspect/route.ts` for monitoring
- **S3**: Dynamic route `[...path]/route.ts` for object operations
  - Static routes for bucket operations (`resources/buckets/[bucket]/`)
  - Dual-mode (REST + custom logic)
- **EC2, IAM, KMS**: Single top-level `route.ts` handler

**Goal**: Standardize route organization - define clear patterns for versioned vs. flat routes

#### 3. **Method Documentation**
- **None implemented** - No service has a README documenting:
  - ✅ Implemented methods
  - ❌ Not-yet-implemented methods
  - Parameters and response types
  - IAM permissions required
  - Examples

**Goal**: Create uniform README template with method tables for each service

#### 4. **Service Setup Code**
- **Lambda**: Explicit imports of handlers: `createFunction`, `deleteFunction`, etc.
- **KMS**: Inline handler definitions with `withKey()` wrapper
- **S3**: Custom protocol handling with `bucketPolicy()` and `bucketOwner()` context logic
- **IAM**: Modular handlers spread from separate files
- **EC2**: Unknown pattern

**Goal**: Standardize handler registration with clear imports and explicit operation list

#### 5. **Error Handling**
- **KMS**: Uses `withKey()` wrapper with try/catch transformation
- **S3**: Uses `s3Operation()` wrapper with bucket ownership validation
- **Lambda**: Inline error handling per operation
- **IAM**: Unclear
- **EC2**: Unclear

**Goal**: Define standard error handling pattern (wrapper vs. inline)

---

## Standardization Plan

### Phase 2.1: Service Structure Analysis & Documentation

**Deliverable**: Detailed audit of each service

```
Phase 2.1: Service Analysis
  ├─ EC2 Service Audit
  │  ├─ Current route patterns
  │  ├─ Operation list (implemented vs. planned)
  │  ├─ Handler organization
  │  └─ Error handling patterns
  ├─ Lambda Service Audit (complex due to versioning)
  ├─ IAM Service Audit
  ├─ S3 Service Audit (complex due to custom wrappers)
  └─ KMS Service Audit
```

### Phase 2.2: README Template Creation

**Template Structure**:
```markdown
# [Service] API Reference

## Overview
Brief description of the service

## Implemented Operations

| Operation | Method | Path | IAM Action | Status |
|-----------|--------|------|-----------|--------|
| ... | GET | /api/[service]/... | [service]:* | ✅ |

## Not Yet Implemented

| Operation | Notes | Priority |
|-----------|-------|----------|
| ... | Reason for not implemented | P0/P1/P2 |

## Error Codes
- Common error codes and meanings

## Examples
Sample requests/responses
```

### Phase 2.3: Uniform Service Implementation

**Standardized Structure**:
```typescript
// service.ts - STANDARDIZED PATTERN
import { defineService } from "../registry"
import { MyProtocol } from "./protocol"

// Handler imports - EXPLICIT
import { 
  operation1Handler, 
  operation2Handler, 
  // ... 
} from "./handlers"

// Operation definitions - EXPLICIT & ORGANIZED
export const myService = defineService({
  iamPrefix: 'myservice',
  protocol: new MyProtocol(),
  operations: {
    Operation1: { handler: operation1Handler, action: 'myservice:Operation1' },
    Operation2: { handler: operation2Handler, action: 'myservice:Operation2' },
    // ...
  },
})

// route.ts - STANDARDIZED PATTERN
import { myService } from "./service"
export const POST = myService.post
export const GET = myService.get
```

### Phase 2.4: Integration Test Framework

**Terraform-based Tests**:
```hcl
# tests/terraform/services/[service].tf
# Each service gets standardized integration tests:
# 1. Validate CRUD operations
# 2. Verify IAM enforcement
# 3. Check network connectivity (where applicable)
# 4. Validate error handling
```

---

## Work Breakdown

### 2.1: EC2 Service Standardization (~2 hours)
- [ ] Audit EC2 service structure
- [ ] List all implemented EC2 operations
- [ ] Identify missing operations
- [ ] Create EC2 README with method tables
- [ ] Refactor service.ts for consistency
- [ ] Update tests to match new pattern
- [ ] Verify network analysis integration

### 2.2: Lambda Service Standardization (~3 hours)
- [ ] Document Lambda versioned routes
- [ ] List implemented Lambda operations per version
- [ ] Create Lambda README with versioning note
- [ ] Standardize operation registration
- [ ] Handle versioned route complexity
- [ ] Update tests

### 2.3: IAM Service Standardization (~1.5 hours)
- [ ] Audit IAM handler organization
- [ ] Create IAM README with operation tables
- [ ] Refactor modular handlers if needed
- [ ] Update tests

### 2.4: S3 Service Standardization (~2 hours)
- [ ] Document S3 dual-mode (REST + custom)
- [ ] List S3 operations implemented
- [ ] Create S3 README
- [ ] Standardize wrapper pattern (s3Operation)
- [ ] Update tests

### 2.5: KMS Service Standardization (~1.5 hours)
- [ ] Create KMS README
- [ ] Verify withKey() wrapper pattern is standard
- [ ] Update tests

### 2.6: Integration Testing (~3 hours)
- [ ] Create Terraform test framework
- [ ] Test each service with standardized tests
- [ ] Validate network connectivity evidence
- [ ] Document test procedures

---

## Success Criteria

✅ Each service has a README.md with:
- Implemented operations table
- Not-yet-implemented operations table
- Method signatures and IAM actions
- Common error codes
- At least one working example

✅ Consistent implementation pattern:
- All services use `defineService()` with explicit operation list
- Clear separation: handlers vs. service registry vs. routes
- Uniform error handling approach
- Standardized import organization

✅ Integration tests pass:
- All existing functionality preserved
- Network connectivity evidence stable
- Terraform tests verify each operation
- IAM enforcement working

✅ Git history clean:
- One commit per major service standardization
- Clear commit messages indicating what was standardized
- All tests passing after each commit

---

## Technical Notes

### Service.ts Pattern (Recommended)
```typescript
// DO THIS:
import { operation1, operation2 } from "./handlers"

export const myService = defineService({
  operations: {
    Operation1: { handler: operation1, action: 'service:Operation1' },
    Operation2: { handler: operation2, action: 'service:Operation2' },
  },
})

// NOT THIS (scattered definitions):
export const myService = defineService({
  operations: {
    Operation1: ctx => { /* inline handler */ },
    Operation2: ctx => { /* inline handler */ },
  },
})
```

### README Template Location
Each service gets: `src/app/api/[service]/README.md`

### Network Evidence
- Preserve all network analysis integration
- EC2 network analysis must continue working
- Lambda network integration (ENI creation/deletion) must be documented
- Include network analysis as a test case

---

## Next Steps

1. **Proceed with Phase 2.1**: EC2 service audit
2. **Build README template** from actual service implementations
3. **Create Terraform test base** for integration testing
4. **Execute standardization** service by service with builds/tests after each
5. **Document learnings** in session checkpoint

