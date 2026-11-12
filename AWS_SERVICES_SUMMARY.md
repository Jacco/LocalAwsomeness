# AWS Services Audit - Quick Reference

## Overview

| Service | Files | LOC | Operations | Pattern | Key Issue |
|---------|-------|-----|-----------|---------|-----------|
| **EC2** | 18 | ~2,850 | 60 (35 R / 25 W) | Query + XML | Wrapper functions instead of explicit Operation objects |
| **Lambda** | 15 | ~971 | 12 (8 R / 4 W) | REST JSON | Mixed handler patterns (functions vs Operation objects) |
| **IAM** | 5 | ~175 | ~19 | Query + XML | Minimal coverage (~19 of 100+ operations) |
| **S3** | 9 | ~1,627 | 12 (5 R / 7 W) | REST XML | Limited bucket config + no multipart/versioning |
| **KMS** | 6 | ~972 | 13 (6 R / 7 W) | JSON 1.1 | Missing core crypto ops (Encrypt/Decrypt) |

## Protocol Distribution

- **Query Protocol** (XML-based): EC2, IAM
- **REST JSON**: Lambda
- **REST XML**: S3
- **JSON 1.1**: KMS

## Implementation Completeness

| Service | Coverage | Status |
|---------|----------|--------|
| EC2 | Network layer only | ~12% (VPC/Security/Routing) |
| Lambda | Basic function management | ~20% (missing config/aliases/perms) |
| IAM | Roles + Policies | ~19% (users minimal, no groups) |
| S3 | Basic CRUD | ~25% (no versioning/multipart/config) |
| KMS | Key management only | ~15% (no crypto operations!) |

## Standardization Gaps by Category

### 1. Handler Pattern (All Services)
- EC2: Wrapper functions (`read()`, `write()`)
- Lambda: Mixed (plain functions + Operation objects)
- IAM: Plain handler functions
- S3: Explicit Operation objects ✓ (best practice)
- KMS: Inline handlers with `withKey()` wrapper

**Standard**: Explicit Operation objects with handler/action/resources

### 2. Error Handling (All Services)
- All use `AwsError`, but inconsistent error categorization
- Lambda has custom error functions (invalidParameter, validation)
- KMS has special error mapping logic

**Standard**: Unified AwsError with consistent type/message/status

### 3. Resource ARNs (All Services)
- EC2: No explicit resources() functions
- Lambda: Partial (functionResource defined but not all operations use it)
- IAM: No resource metadata
- S3: Explicit with bucketArn(), objectArn() ✓
- KMS: Explicit with keyResource() ✓

**Standard**: All operations define resources() callback

### 4. Documentation (All Services)
- NONE have service README with operation table
- NONE document implemented vs not-implemented
- No protocol/routing documentation

**Standard**: README.md per service with full operation inventory

### 5. Operation Coverage

**High Priority** (critical operations):
- KMS: Encrypt, Decrypt, GenerateDataKey, Sign, Verify
- Lambda: UpdateFunctionConfiguration, TagResource/UntagResource
- S3: Multipart upload, CopyObject, versioning
- IAM: CreateUser, GetUser, UpdateUser, CreateGroup, GetGroup
- EC2: RunInstances, TerminateInstances, CreateVolume

**Medium Priority** (commonly used):
- All: Tagging operations (TagResource, UntagResource, ListResourceTags)
- All: Resource-based policies where applicable
- All: Pagination (Marker/MaxItems/NextToken)

**Lower Priority** (advanced):
- KMS: Grants, custom key stores, aliases
- S3: Replication, CORS, lifecycle, request payment
- Lambda: Layers, code signing, function URLs

## Phase 2 Implementation Order

### Phase 2.1: Standardize Handler Pattern (All Services)
- Convert all operations to explicit Operation objects
- Define resources() callback for each
- Define action field for each (derive from <iamPrefix>:<operation>)
- Consolidate error handling

### Phase 2.2: Add Missing Critical Operations
1. **KMS**: Encrypt, Decrypt (blocking crypto operations)
2. **Lambda**: UpdateFunctionConfiguration, Alias operations
3. **S3**: Multipart upload, CopyObject, basic versioning
4. **IAM**: User CRUD, basic groups
5. **EC2**: Instances basic lifecycle (RunInstances, TerminateInstances)

### Phase 2.3: Documentation & Testing
- Create README.md in each service with operation table
- Generate Terraform integration tests
- Document protocol and routing details
- Add validation/example payloads

### Phase 2.4: Expand Coverage
- Add remaining high-priority operations
- Implement tagging for all services
- Add pagination where needed
- Add resource-based policies

## Key Metrics for Success

- [ ] All 5 services use explicit Operation objects
- [ ] All operations define resources() function
- [ ] All operations define action field
- [ ] All services have README with full operation inventory
- [ ] Error handling unified across all services
- [ ] 90%+ of high-priority operations implemented
- [ ] Terraform integration tests passing for all services

---

**Full audit**: See `AWS_SERVICES_AUDIT.md` for detailed analysis of each service.
