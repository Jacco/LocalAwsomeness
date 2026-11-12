# Codebase Refactoring Plan

## Objective

Transform the `src/app/api/` directory from a mixed concerns layout into a clean, maintainable structure where:
1. **Cross-cutting concerns** are moved to appropriate locations
2. **Each service** has identical setup and documentation
3. **Service READMEs** have implemented and not-implemented operation tables
4. **All changes** are validated with Terraform and network evidence tests

---

## Phase 1: Directory Restructuring (Cross-Cutting Concerns)

### Move 1: `src/app/api/db/` → `src/app/data/`

**Why:** Database layer serves all services, not just API endpoints

```
Before: src/app/api/db/
  ├── account.ts
  ├── ec2/
  ├── lambda.ts
  ├── organizations.ts
  └── ...

After: src/app/data/
  ├── account.ts
  ├── ec2/
  ├── lambda.ts
  ├── organizations.ts
  └── ...
```

**Affected imports:** Update 25+ files that import from `../db/` to `../../data/`

**Testing:** No functional change, just imports. Run tests to verify.

---

### Move 2: `src/app/api/network/` → `src/app/analysis/network/`

**Why:** Network analysis is a cross-cutting analysis layer, not a service API

```
Before: src/app/api/network/
  ├── reach.ts (network trace engine)
  ├── routes.ts (route resolution)
  ├── trace.ts (trace data types)
  ├── live.ts (live network queries)
  └── inspect/

After: src/app/analysis/network/
  ├── reach.ts
  ├── routes.ts
  ├── trace.ts
  ├── live.ts
  └── inspect/
```

**Affected imports:** Update EC2, Lambda services and tests that use network analysis

**New structure:**
```
src/app/analysis/
├── network/
│   ├── reach.ts
│   ├── routes.ts
│   ├── trace.ts
│   ├── live.ts
│   ├── inspect/
│   └── __tests__/
└── README.md (Analysis layer overview)
```

**Testing:** Network trace tests must pass, evidence output unchanged

---

### Move 3: `src/app/api/policy/` → `src/app/auth/policy/`

**Why:** Authorization policy is authentication/authorization concern, not API

```
Before: src/app/api/policy/
  ├── engine.ts (policy evaluation)
  ├── authorizer.ts
  ├── principal.ts
  └── identity.ts

After: src/app/auth/policy/
  ├── engine.ts
  ├── authorizer.ts
  ├── principal.ts
  └── identity.ts
```

**Affected imports:** Update middleware and handler files

**Testing:** Authorization tests continue to pass

---

### Move 4: `src/app/api/runtime/` → `src/lib/lambda-runtime/`

**Why:** Lambda runtime is a utility library for code execution, not an API service

```
Before: src/app/api/runtime/
  ├── run.ts (code executor)
  ├── netshim.py (network shim)
  └── run/

After: src/lib/lambda-runtime/
  ├── run.ts
  ├── netshim.py
  └── run/
```

**Affected imports:** Update Lambda service files that call runtime

**Testing:** Lambda function invocation tests continue to work

---

### Move 5: Keep `src/app/api/resources/s3/`

**Rationale:** This IS part of the S3 API (resource inspector), keep it with S3 service

**However:** Reorganize within S3 service for clarity

```
src/app/api/s3/
├── service.ts
├── route.ts
├── protocol.ts
├── storage.ts
├── policy.ts
├── resources/          ← Renamed from /resources/s3/
│   ├── buckets.ts
│   └── README.md
└── __tests__/
```

---

## Phase 2: Service Directory Standardization

After cross-cutting concerns are moved, standardize each service directory.

### Standard Service Structure

```
src/app/api/SERVICE/
├── README.md                    ← NEW: Implemented/not-implemented tables
├── service.ts                   ← Service definition & routing
├── protocol.ts                  ← Wire protocol handling (JSON, Query, REST, etc)
├── handlers.ts OR route.ts      ← Operation handlers (if not in service.ts)
├── model.ts                     ← TypeScript interfaces & data types
├── *.ts                         ← Feature files (vpc.ts, subnet.ts, etc for EC2)
├── <version>/                   ← If service has versions (Lambda, CloudFormation)
│   └── [action]/
│       └── route.ts
├── resources/                   ← Sub-resources (EC2: tags, filters, etc)
│   └── *.ts
├── __tests__/
│   ├── service.test.ts
│   ├── protocol.test.ts
│   └── operations.test.ts
└── SERVICE.md                   ← Detailed implementation notes
```

### README.md Template for Each Service

```markdown
# SERVICE_NAME API

**Protocol:** [JSON/Query/REST/etc]  
**AWS Documentation:** [link]  
**Implementation Status:** X% (N operations implemented)

## Implemented Operations

| Category | Operation | Status | Notes |
|----------|-----------|--------|-------|
| Accounts | DescribeAccount | ✅ | Fully working |
| Accounts | GetAccount | ❌ | Not implemented |
| ... | ... | ... | ... |

**Total Implemented:** N / M operations

## Not Yet Implemented Operations

| Category | Operation | Priority | Notes |
|----------|-----------|----------|-------|
| Billing | GetBillingInfo | Low | Requires cost tracking |
| Security | EncryptionStatus | Medium | Partial implementation exists |
| ... | ... | ... | ... |

**Total Not Implemented:** M - N operations

## Implementation Notes

- Wire protocol details
- Special behavior/workarounds
- Known limitations
- Terraform compatibility notes
```

---

## Phase 3: Create Service Documentation for Each

Services to standardize (priority order based on test coverage):

### High Priority (Already have good tests)
1. **EC2** - Many operations, complex routing, network analysis integrated
2. **Lambda** - VPC integration, network evidence testing
3. **IAM** - Policy core, authorization testing
4. **S3** - Recently refactored, good test coverage

### Medium Priority
5. **KMS** - Encryption operations
6. **SSM** - Parameter/secret storage
7. **CloudFormation** - Stack management
8. **Organizations** - Account management, SCPs

### Lower Priority
9. **Logs** - CloudWatch Logs
10. **EFS** - Elastic File System
11. **Service Quotas** - Quota management
12. **STS** - Security Token Service
13. **CloudTrail** - Audit logging

### Template: EC2 README.md Example

**Implemented Table Structure:**
```
| Resource Type | Operation | Status | Lines | Tests |
|---|---|---|---|---|
| VPC | CreateVpc | ✅ | 45 | 3 |
| VPC | DeleteVpc | ✅ | 32 | 2 |
| VPC | DescribeVpcs | ✅ | 68 | 5 |
| Subnet | CreateSubnet | ✅ | 52 | 4 |
| ... | ... | ... | ... | ... |
```

---

## Phase 4: Integration Testing

### Terraform Test Suite

**Run existing tests:**
```bash
# After each cross-cutting move
cd tests/terraform
terraform test -verbose

# Verify no regressions
npm test -- network.test.ts
npm test -- ec2.test.ts
npm test -- lambda.test.ts
```

**Test Scenarios (by service):**

#### EC2 + Network Evidence
- Create VPC → Subnet → Route Table → Check network trace
- Create security group → Verify trace shows rules
- Create NAT Gateway → Verify interface recognized
- Lambda VPC attachment → Verify interface auto-created & traced
- Cross-account routing → Verify TGW tracing (Phase 4.2)

#### Lambda + Network Evidence
- VPC-attached function → Verify interface in trace
- Function deletion → Verify interface cleanup
- Multiple functions same (subnet, SG) → Verify interface sharing
- Network trace through Lambda function ENI

#### S3 + IAM
- Bucket with IAM policy → Verify policy evaluation
- Cross-account bucket access → Verify authorization
- S3 + VPC endpoint → Verify endpoint routing

#### IAM + Organizations
- IAM role assumptions across accounts
- SCP attachment → Verify effective policy (Phase 5)
- Organization delegation

#### KMS + Everything
- Encryption with KMS → Verify key usage
- Cross-account key sharing → Verify policy attachment
- EC2 + KMS for EBS encryption

### Network Evidence Testing

After each service refactor, verify:

```typescript
// Test: Network trace evidence unchanged
test('Network trace evidence format remains constant', async () => {
  const vpc = await ec2.createVpc(...)
  const subnet = await ec2.createSubnet(...)
  const trace = await network.tracePacket({
    source: '10.0.1.1',
    destination: '10.0.2.1'
  })
  
  // Verify evidence types unchanged
  expect(trace.evidence).toContain({ kind: 'route' })
  expect(trace.evidence).toContain({ kind: 'network-acl' })
  expect(trace.evidence).toContain({ kind: 'security-group' })
})
```

---

## Execution Plan (7 Phases)

### Phase 1A: Move `db/` → `data/`
- [ ] Rename directory
- [ ] Update all imports (~30 files)
- [ ] Run full test suite
- [ ] Verify build
- [ ] Commit

**Estimated time:** 1-2 hours

---

### Phase 1B: Move `runtime/` → `src/lib/lambda-runtime/`
- [ ] Create `src/lib/` directory structure
- [ ] Move files
- [ ] Update imports in Lambda service
- [ ] Test Lambda function invocation
- [ ] Commit

**Estimated time:** 30 minutes

---

### Phase 1C: Move `policy/` → `src/app/auth/policy/`
- [ ] Create `src/app/auth/` directory
- [ ] Move policy files
- [ ] Update imports
- [ ] Test authorization
- [ ] Commit

**Estimated time:** 30 minutes

---

### Phase 1D: Move `network/` → `src/app/analysis/network/`
- [ ] Create `src/app/analysis/` directory
- [ ] Move network files
- [ ] Update 20+ imports in services
- [ ] Run network tests
- [ ] Run EC2 + Lambda tests (they use network analysis)
- [ ] Verify network trace evidence output
- [ ] Terraform integration tests
- [ ] Commit

**Estimated time:** 2-3 hours

---

### Phase 1E: Reorganize `resources/s3/` within S3 service
- [ ] Move to `src/app/api/s3/resources/`
- [ ] Update imports
- [ ] Test S3 resource operations
- [ ] Commit

**Estimated time:** 30 minutes

---

### Phase 2: Standardize Service Directories (Services A-E)

For each service in this order:

#### A. EC2 Service
1. [ ] Create uniform file structure (if not already)
2. [ ] Move feature files into organized locations
3. [ ] Create `src/app/api/ec2/README.md` with tables
4. [ ] Document all implemented operations (50+)
5. [ ] Document not-implemented (50+)
6. [ ] Run all EC2 tests
7. [ ] Run network evidence tests
8. [ ] Terraform test EC2 scenarios
9. [ ] Commit

**Estimated time:** 3-4 hours

---

#### B. Lambda Service
1. [ ] Standardize structure
2. [ ] Create `src/app/api/lambda/README.md`
3. [ ] Document operations (Create, Update, Delete, Invoke, etc)
4. [ ] Run Lambda tests
5. [ ] Test VPC attachment + network trace
6. [ ] Terraform test Lambda scenarios
7. [ ] Commit

**Estimated time:** 2-3 hours

---

#### C. IAM Service
1. [ ] Standardize structure
2. [ ] Create `src/app/api/iam/README.md`
3. [ ] Document operations (CreateRole, CreateUser, etc)
4. [ ] Run IAM tests
5. [ ] Test cross-account role assumption
6. [ ] Commit

**Estimated time:** 2 hours

---

#### D. S3 Service
1. [ ] Standardize structure
2. [ ] Create `src/app/api/s3/README.md`
3. [ ] Document operations
4. [ ] Verify resource operations still work
5. [ ] Terraform test S3 scenarios
6. [ ] Commit

**Estimated time:** 1.5 hours

---

#### E. KMS Service
1. [ ] Standardize structure
2. [ ] Create `src/app/api/kms/README.md`
3. [ ] Document operations
4. [ ] Test with EC2 encryption
5. [ ] Commit

**Estimated time:** 1.5 hours

---

### Phase 3: Remaining Services (F-M)

Repeat standardization for remaining services in priority order:
- F. SSM (1.5 hrs)
- G. CloudFormation (1.5 hrs)
- H. Organizations (1 hr)
- I. Logs (1 hr)
- J. EFS (1 hr)
- K. Service Quotas (1 hr)
- L. STS (1 hr)
- M. CloudTrail (1 hr)

**Total:** ~12 hours

---

### Phase 4: Comprehensive Integration Testing

- [ ] Full Terraform test suite against all services
- [ ] Network evidence regression test
- [ ] Cross-service scenarios (EC2 + Lambda + S3 + IAM)
- [ ] Backward compatibility check
- [ ] Performance baseline

**Estimated time:** 4-6 hours

---

## Rollback Strategy

If issues occur during refactoring:

1. **After each phase commit:** Create annotated git tag
   ```bash
   git tag -a refactor-phase-1a -m "After db→data move"
   ```

2. **If tests fail:** Revert to previous tag
   ```bash
   git reset --hard refactor-phase-1a
   ```

3. **Identify issue → Fix → Retry**

---

## Success Criteria

✅ All cross-cutting concerns in proper locations  
✅ Each service has identical directory structure  
✅ Each service has comprehensive README with operation tables  
✅ All existing tests pass  
✅ Terraform tests pass  
✅ Network evidence output unchanged  
✅ No functional regressions  
✅ Build is clean  
✅ Code coverage maintained  

---

## Timeline Summary

| Phase | Tasks | Estimated Time |
|-------|-------|-----------------|
| 1A | Move db/ | 1-2 hrs |
| 1B | Move runtime/ | 30 min |
| 1C | Move policy/ | 30 min |
| 1D | Move network/ | 2-3 hrs |
| 1E | Reorganize resources/ | 30 min |
| **Phase 1 Total** | Cross-cutting moves | **5-7 hrs** |
| 2A-E | Standardize 5 services | 8-13 hrs |
| 3F-M | Standardize 8 services | ~12 hrs |
| 4 | Integration testing | 4-6 hrs |
| **Grand Total** | Full refactoring | **~30-40 hrs** |

---

## Recommendation

**Start with Phase 1 immediately** (most impactful, lowest risk):
- Clear directory structure
- Separate concerns properly
- No functional changes
- Tests validate everything

**Then tackle services in priority order:**
1. EC2 (most complex, most tests)
2. Lambda (network integration critical)
3. IAM (authorization foundation)
4. S3 (resource management)
5. Remaining services (lower priority)

Each service standardization is independent and can be completed separately.
