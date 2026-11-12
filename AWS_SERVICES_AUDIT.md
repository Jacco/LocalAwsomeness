# AWS Services Implementation Audit

This audit analyzes 5 AWS service implementations (EC2, Lambda, IAM, S3, KMS) for Phase 2 standardization.

## 1. EC2 Service

### Current Implementation Pattern
- **File Organization**: Modular handler approach with separate files for each resource type (vpc.ts, subnet.ts, securitygroup.ts, etc.)
- **Operation Definition**: Uses `defineService()` with explicit operation object containing read/write wrapped handlers
- **Handler Organization**: Operations exported from separate files as `Op` functions, wrapped with `read()` / `write()` helpers
- **Error Handling**: Uses `AwsError` for validation failures; DryRun operations throw `DRY_RUN_OPERATION()`
- **State Management**: Loads state at operation start, saves only on mutations
- **Protocol**: Query protocol (EC2Protocol) with form-based input and XML output
- **Total Files**: 18 TypeScript files
- **Total Lines**: ~2,850 LOC

### Operation Inventory
**Implemented Operations (60 total)**:
- **VPC Operations** (9): CreateVpc, DeleteVpc, DescribeVpcs, ModifyVpcAttribute, DescribeVpcAttribute, AssociateVpcCidrBlock, DisassociateVpcCidrBlock, CreateDefaultVpc
- **Subnet Operations** (5): CreateSubnet, DeleteSubnet, DescribeSubnets, ModifySubnetAttribute, CreateDefaultSubnet
- **Internet Gateway** (4): CreateInternetGateway, DeleteInternetGateway, AttachInternetGateway, DetachInternetGateway
- **Route Table** (8): CreateRouteTable, DeleteRouteTable, CreateRoute, ReplaceRoute, DeleteRoute, AssociateRouteTable, DisassociateRouteTable, ReplaceRouteTableAssociation
- **Security Group** (10): CreateSecurityGroup, DeleteSecurityGroup, AuthorizeSecurityGroupIngress, AuthorizeSecurityGroupEgress, RevokeSecurityGroupIngress, RevokeSecurityGroupEgress, ModifySecurityGroupRules, UpdateSecurityGroupRuleDescriptionsIngress, UpdateSecurityGroupRuleDescriptionsEgress, DescribeSecurityGroupRules
- **Network ACL** (6): CreateNetworkAcl, DeleteNetworkAcl, CreateNetworkAclEntry, ReplaceNetworkAclEntry, DeleteNetworkAclEntry, ReplaceNetworkAclAssociation
- **Elastic IP** (4): AllocateAddress, ReleaseAddress, DisassociateAddress, DescribeAddresses
- **NAT Gateway** (3): CreateNatGateway, DeleteNatGateway, DescribeNatGateways
- **VPC Endpoint** (4): CreateVpcEndpoint, DeleteVpcEndpoint, DescribeVpcEndpoints, ModifyVpcEndpoint
- **Query** (3): DescribeRegions, DescribeAvailabilityZones, DescribeAccountAttributes
- **Tags** (3): CreateTags, DeleteTags, DescribeTags
- **Read-only Describes** (6): DescribeRouteTables, DescribeNetworkAcls, DescribeSecurityGroups, DescribeInternetGateways, DescribeDhcpOptions, DescribeNetworkInterfaces

**Pattern**: READ (35 operations) vs WRITE (25 operations)
**Missing**: EC2 Instances, Volumes, Snapshots, Images, Key Pairs, etc.

### Service Structure Observations
- **File Organization**: Resource-centric (vpc.ts, subnet.ts, routetable.ts, securitygroup.ts, etc.)
- **Protocol**: Query protocol with form-based encoding and XML response
- **IAM Prefix**: `ec2`
- **Middleware**: Account/region validation wrapper; DryRun validation wrapper
- **State Persistence**: Uses `src/app/api/data/ec2/state` for account-region scoped storage
- **Error Strategy**: Validation-first, DryRun-compliant

### Gaps & Standardization Opportunities
1. **Handler Pattern Inconsistency**: Handlers use wrapper functions (`read()`, `write()`) instead of explicit operation definitions with handlers and metadata
2. **Missing Operations**: EC2 instances, volumes, snapshots, AMIs, key pairs, network interfaces are unimplemented
3. **Naming Convention**: No consistent README documentation per resource type
4. **Testing**: No inline validation documented for operation parameters
5. **IAM Resource Arns**: Not explicitly defined in operation metadata (could be in resources callback)
6. **Versioning**: No API version parameter tracking

---

## 2. Lambda Service

### Current Implementation Pattern
- **File Organization**: Functional handlers in separate files (functions.ts, invoke.ts, code.ts, network.ts, etc.)
- **Operation Definition**: Uses `defineService()` with mixed handler functions and Operation objects
- **Handler Organization**: Some operations are plain functions, others are Operation objects with resource/action metadata
- **Error Handling**: Custom error types (invalidParameter, validation) plus AwsError
- **State Management**: Uses `loadLambda()` / `saveLambda()` for function state; EC2 state for VPC validation
- **Protocol**: REST JSON protocol with path-based operation routing
- **Total Files**: 15 TypeScript files
- **Total Lines**: ~971 LOC

### Operation Inventory
**Implemented Operations (12 total)**:
- **Function Management** (6): CreateFunction, GetFunction, GetFunctionConfiguration, ListFunctions, ListVersionsByFunction, DeleteFunction
- **Function Code** (1): UpdateFunctionCode
- **Configuration** (3): GetFunctionCodeSigningConfig, GetFunctionRecursionConfig, GetFunctionConcurrency
- **Tagging** (1): ListTags
- **Invocation** (1): Invoke

**Pattern**: READ (8 operations) vs WRITE (4 operations)
**Missing**: UpdateFunctionConfiguration, TagResource, UntagResource, PublishVersion, CreateAlias, DeleteAlias, UpdateAlias, ListAliases, GetAlias, AddPermission, RemovePermission, GetPolicy

### Service Structure Observations
- **File Organization**: Functional area separation (functions.ts, code.ts, invoke.ts, network.ts, logging.ts)
- **Protocol**: REST JSON with path parameters and special header handling for Invoke
- **IAM Prefix**: `lambda`
- **Routing Complexity**: Multiple API versions (2015-03-31, 2017-03-31, 2019-09-30, 2020-06-30, 2024-08-31)
- **Resource Context**: Uses `functionArn()` for resource-based IAM policy
- **Validation**: VPC subnet/security group validation against EC2 state
- **State Persistence**: Uses `src/app/api/data/lambda` for function records

### Gaps & Standardization Opportunities
1. **Mixed Operation Definitions**: Some operations are plain handlers, others have explicit Operation objects with action/resources metadata
2. **Versioning Complexity**: Multiple API version routes but single service handler; needs clarification on how versions are reconciled
3. **Missing Core Operations**: UpdateFunctionConfiguration, alias management, tagging operations (TagResource/UntagResource)
4. **Error Handling**: Custom error functions alongside AwsError; needs consolidation
5. **Resource Policy**: Not yet implemented (lambda resource-based policies)
6. **Code Signing Config**: Marked as unsupported in CreateFunction but has a get operation

---

## 3. IAM Service

### Current Implementation Pattern
- **File Organization**: Spread across roles.ts, users.ts, policies.ts with separate handler functions
- **Operation Definition**: Uses `defineService()` with handlers merged from three separate handler objects
- **Handler Organization**: Handlers as functions within role/policy/user files; handlers take QueryParams context
- **Error Handling**: Uses AwsError and QueryParams' required/optional methods for validation
- **State Management**: Uses `src/app/api/data/iam` for role/user/policy storage
- **Protocol**: Query protocol with XML output
- **Total Files**: 5 TypeScript files
- **Total Lines**: ~175 LOC

### Operation Inventory
**Implemented Operations (~19 total)**:
- **Role Operations** (12): CreateRole, GetRole, ListRoles, DeleteRole, PutRolePolicy, GetRolePolicy, DeleteRolePolicy, ListRolePolicies, AttachRolePolicy, DetachRolePolicy, ListInstanceProfilesForRole, ListAttachedRolePolicies
- **Policy Operations** (3): ListPolicies, GetPolicy, GetPolicyVersion
- **User Operations** (3+): ListUsers (more operations likely in users.ts)

**Pattern**: READ-heavy, simple CRUD operations
**Missing**: UpdateRole, UpdateRolePolicy, CreateUser, DeleteUser, GetUser, UpdateUser, AddUserToGroup, RemoveUserFromGroup, CreatePolicy, UpdatePolicyVersion, DeletePolicy, and many more

### Service Structure Observations
- **File Organization**: Resource-type separation (roles.ts, users.ts, policies.ts)
- **Protocol**: Query protocol (XML-based)
- **IAM Prefix**: `iam`
- **Handler Pattern**: Each handler function validates parameters via QueryParams, returns result object
- **Pagination**: TODO comment indicates pagination (Marker, MaxItems) not yet implemented
- **ARN Generation**: Uses ARN builder for role/policy/user arns

### Gaps & Standardization Opportunities
1. **Minimal Operation Coverage**: Only ~19 operations implemented of hundreds available in IAM
2. **No Resource-Based Policies**: No support for inline or managed policies on users
3. **Missing Tagging**: No TagRole, UntagRole operations
4. **Pagination Incomplete**: TODO indicates Marker/MaxItems for pagination not implemented
5. **No Instance Profiles**: CreateInstanceProfile, GetInstanceProfile, AddRoleToInstanceProfile not implemented
6. **Inconsistent Documentation**: No explicit operation metadata with resources/actions
7. **Service Definition**: Sparse; operations merged from three handler objects without explicit metadata

---

## 4. S3 Service

### Current Implementation Pattern
- **File Organization**: Modular with resource-specific files (storage.ts, policy.ts, protocol.ts) plus operation implementations (s3.ts)
- **Operation Definition**: Uses `defineService()` with explicit Operation objects for each operation
- **Handler Organization**: Operations wrapped with `s3Operation()` middleware; `on()` helper adds resource/action metadata
- **Error Handling**: AwsError with S3-specific status mappings; bucket policy authorization support
- **State Management**: Uses `s3Storage` singleton for bucket ownership and policy retrieval
- **Protocol**: REST protocol with vhost-style bucket naming and path-style operation routing
- **Total Files**: 9 TypeScript files
- **Total Lines**: ~1,627 LOC

### Operation Inventory
**Implemented Operations (12 total)**:
- **Bucket Lifecycle** (3): CreateBucket, DeleteBucket, HeadBucket
- **Bucket Policy** (3): GetBucketPolicy, PutBucketPolicy, DeleteBucketPolicy
- **Object Operations** (5): GetObject, PutObject, DeleteObject, HeadObject, ListObjectsV2
- **Enumeration** (1): ListBuckets

**Pattern**: READ (5 operations) vs WRITE (7 operations)
**Missing**: GetBucketCors, PutBucketCors, DeleteBucketCors, GetBucketVersioning, PutBucketVersioning, GetBucketLocation, PutBucketVersioning, GetBucketEncryption, PutBucketEncryption, GetBucketReplication, PutBucketReplication, GetBucketLifecycle, PutBucketLifecycle, GetBucketAcl, PutBucketAcl, ListObjectVersions, CopyObject, GetObjectAcl, PutObjectAcl, etc.

### Service Structure Observations
- **File Organization**: Operation implementations in s3.ts; storage/policy in separate files; protocol handler specialized
- **Protocol**: REST protocol (vhost-style) with XML and raw byte responses
- **IAM Prefix**: `s3`
- **Middleware**: `s3Operation()` wrapper handles bucket owner resolution and account validation
- **Resource Policy**: Full support for bucket policies with bucket owner context
- **Cross-Account**: Explicit support for cross-account access via `ExpectedBucketOwner` parameter
- **Response Modes**: XML (listings), raw bytes (object data), headers-only (HEAD operations)

### Gaps & Standardization Opportunities
1. **Limited Object Operations**: Only basic CRUD; missing copy, multipart upload, versioning, acl operations
2. **Missing Bucket Configuration**: No CORS, versioning, replication, encryption, lifecycle, ACL operations
3. **No Tagging**: Missing GetBucketTagging, PutBucketTagging, DeleteBucketTagging, GetObjectTagging, PutObjectTagging
4. **No Multipart Upload**: Missing InitiateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload
5. **Response Type Handling**: Needs better documentation of when XML vs raw bytes vs headers are returned
6. **ListObjectVersions**: Missing alongside ListObjectsV2
7. **Error Handling**: Comprehensive but not all S3 error cases covered (e.g., NoSuchUpload, InvalidPartOrder)

---

## 5. KMS Service

### Current Implementation Pattern
- **File Organization**: Centralized in kms.ts with storage.ts for persistence and validator.ts for validation
- **Operation Definition**: Uses `defineService()` with inline handler functions, many using `withKey()` wrapper
- **Handler Organization**: Handlers defined inline within service definition; key resolution logic factored to `withKey()`
- **Error Handling**: AwsError with KMS-specific error types (NotFoundException, ValidationException, KMSInvalidStateException)
- **State Management**: Uses `src/app/api/data/kms/storage` for key metadata and policies
- **Protocol**: JSON 1.1 protocol with x-amz-target header routing
- **Total Files**: 6 TypeScript files
- **Total Lines**: ~972 LOC

### Operation Inventory
**Implemented Operations (13 total)**:
- **Key Management** (3): CreateKey, ListKeys, DescribeKey
- **Key Policy** (2): GetKeyPolicy, PutKeyPolicy
- **Key Rotation** (3): EnableKeyRotation, DisableKeyRotation, GetKeyRotationStatus
- **Key State** (3): EnableKey, DisableKey, ScheduleKeyDeletion
- **Cancellation** (1): CancelKeyDeletion

**Pattern**: READ (6 operations) vs WRITE (7 operations)
**Missing**: GenerateDataKey, GenerateDataKeyWithoutPlaintext, Encrypt, Decrypt, ReEncrypt, Sign, Verify, GetPublicKey, UpdateKeyDescription, TagResource, UntagResource, ListResourceTags, CreateGrant, RetireGrant, ListGrants, DescribeCustomKeyStores, etc.

### Service Structure Observations
- **File Organization**: Monolithic service definition in kms.ts; storage and validation in separate files
- **Protocol**: JSON 1.1 protocol (AWS KMS native, TrentService)
- **IAM Prefix**: `kms`
- **Key Resolution**: Validates UUID format and ARN structure; only CUSTOMER_MANAGED keys supported
- **Metadata Transformation**: Converts storage KeyMetadata to API response format with timestamp conversion
- **Policy Handling**: JSON policy parsing and serialization with validation
- **Special Routing**: Uses TrentService routing via x-amz-target header; separate route at `/api/kms/TrentService/[action]/route.ts`

### Gaps & Standardization Opportunities
1. **Critical Missing Operations**: Encrypt, Decrypt, GenerateDataKey, Sign, Verify - the core cryptographic operations
2. **No Grants**: Grant management (CreateGrant, RetireGrant, ListGrants) not implemented
3. **No Tagging**: TagResource, UntagResource, ListResourceTags missing
4. **No Customer Managed Key Stores**: Custom key store operations not supported
5. **Handler Inline Pattern**: All handlers defined inline; should be split into separate files for maintainability
6. **Key Alias Support**: Key aliases (mentioned as not yet supported in resolveKeyId)
7. **Custom Dual-Route Handler**: Uses both `/api/kms/route.ts` and `/api/kms/TrentService/[action]/route.ts` - routing clarity needed
8. **Response Format**: KeyMetadata transformation logic duplicated across multiple operations

---

## Phase 2 Standardization Requirements

### Standard Pattern to Adopt

All services should follow this structure:

```typescript
// service.ts
export const SERVICE = defineService({
  iamPrefix: 'service',
  protocol: new PROTOCOL(),
  operations: {
    OperationName: {
      handler: (ctx) => { /* implementation */ },
      action: 'service:OperationName',
      resources: (ctx) => [ /* resource arns */ ],
      resourcePolicy: (ctx) => { /* bucket policy etc */ }
    }
  }
})

// route.ts
import { SERVICE } from './service'
export const POST = SERVICE.post
```

### Key Standardization Checklist

- [ ] **Operation Definitions**: All operations use explicit `Operation` objects with handler/action/resources
- [ ] **Handler Organization**: Handlers in separate files by resource type or functional area, imported and composed
- [ ] **Error Handling**: Consistent AwsError usage with proper error codes and HTTP status mappings
- [ ] **Route Files**: Minimal route.ts files; use SERVICE.post/postDynamic as appropriate
- [ ] **IAM Resource ARNs**: Explicit resources() function on each operation for IAM policy engine
- [ ] **Protocol Implementation**: Clear protocol adapter for encoding/decoding; support for versioning if needed
- [ ] **State Management**: Clear data layer abstraction via src/app/api/data/{service}/
- [ ] **Documentation**: README.md in each service directory with:
  - Implemented vs Not-Implemented operation table
  - Protocol and routing details
  - Example request/response
  - Known limitations
- [ ] **Validation**: Consistent parameter validation with clear error messages
- [ ] **Testing**: Integration test stubs for Terraform validation

### Service-Specific Recommendations

**EC2**: 
- Move operation definitions from wrapper functions to explicit Operation objects
- Implement missing core resources (Instances, Volumes, Snapshots, AMIs)
- Document resource ARN patterns

**Lambda**:
- Consolidate mixed handler patterns (plain functions vs Operation objects)
- Implement missing configuration/alias/permission operations
- Document API version routing strategy
- Add resource-based policy support

**IAM**:
- Significantly expand operation coverage
- Implement pagination (Marker/MaxItems)
- Add tagging operations
- Document policy document handling

**S3**:
- Expand bucket configuration operations (CORS, versioning, replication, encryption, lifecycle)
- Implement multipart upload operations
- Add tagging support
- Document S3 REST routing edge cases

**KMS**:
- Implement critical cryptographic operations (Encrypt, Decrypt, GenerateDataKey, Sign, Verify)
- Split handlers into separate files for readability
- Add grant management
- Add tagging support
- Support key aliases
- Consolidate dual-route handling

