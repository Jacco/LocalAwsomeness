# Lambda API Reference

**Service IAM Prefix**: `lambda`  
**Protocol**: REST/JSON (AWS Lambda Runtime API)  
**Documentation**: [AWS Lambda API Reference](https://docs.aws.amazon.com/lambda/latest/api/)

---

## Overview

The Lambda service provides serverless function execution and lifecycle management. In this simulator, Lambda handles:
- Function creation, configuration, and deletion
- Function code storage and updates
- Synchronous and asynchronous function invocation
- Version management and aliases
- Concurrency controls
- Code signing configuration
- Function tags and metadata
- Recursive invocation detection (anti-loop safety)

**Key Integration**: Lambda creates temporary network interfaces (ENIs) in configured VPCs/subnets, which are modeled through the network analysis layer (`src/app/analysis/network/`). ENIs are automatically created during invocation and deleted when no longer needed.

---

## Implemented Operations

### Core Function Management

| # | Operation | API | Path Pattern | IAM Action | Handler | Status |
|----|-----------|-----|--------------|-----------|---------|--------|
| 1 | CreateFunction | POST | `/api/lambda/2015-03-31/functions` | `lambda:CreateFunction` | `functions.ts` | ✅ |
| 2 | GetFunction | GET | `/api/lambda/2015-03-31/functions/{FunctionName}` | `lambda:GetFunction` | `functions.ts` | ✅ |
| 3 | DeleteFunction | DELETE | `/api/lambda/2015-03-31/functions/{FunctionName}` | `lambda:DeleteFunction` | `functions.ts` | ✅ |
| 4 | ListFunctions | GET | `/api/lambda/2015-03-31/functions` | `lambda:ListFunctions` | `functions.ts` | ✅ |
| 5 | GetFunctionConfiguration | GET | `/api/lambda/2015-03-31/functions/{FunctionName}/configuration` | `lambda:GetFunctionConfiguration` | `functions.ts` | ✅ |
| 6 | UpdateFunctionCode | PUT | `/api/lambda/2015-03-31/functions/{FunctionName}/code` | `lambda:UpdateFunctionCode` | `functions.ts` | ✅ |

### Function Invocation

| # | Operation | API | Path Pattern | IAM Action | Handler | Status |
|----|-----------|-----|--------------|-----------|---------|--------|
| 7 | Invoke | POST | `/api/lambda/2015-03-31/functions/{FunctionName}/invocations` | `lambda:InvokeFunction` | `invoke.ts` | ✅ |

### Versioning & Aliases

| # | Operation | API | Path Pattern | IAM Action | Handler | Status |
|----|-----------|-----|--------------|-----------|---------|--------|
| 8 | ListVersionsByFunction | GET | `/api/lambda/2015-03-31/functions/{FunctionName}/versions` | `lambda:ListVersionsByFunction` | `functions.ts` | ✅ |

### Concurrency Control

| # | Operation | API | Path Pattern | IAM Action | Handler | Status |
|----|-----------|-----|--------------|-----------|---------|--------|
| 9 | GetFunctionConcurrency | GET | `/api/lambda/2019-09-30/functions/{FunctionName}/concurrency` | `lambda:GetFunctionConcurrency` | `functions.ts` | ✅ |

### Code Signing

| # | Operation | API | Path Pattern | IAM Action | Handler | Status |
|----|-----------|-----|--------------|-----------|---------|--------|
| 10 | GetFunctionCodeSigningConfig | GET | `/api/lambda/2020-06-30/functions/{FunctionName}/code-signing-config` | `lambda:GetFunctionCodeSigningConfig` | `functions.ts` | ✅ |

### Recursion Detection (Anti-Loop)

| # | Operation | API | Path Pattern | IAM Action | Handler | Status |
|----|-----------|-----|--------------|-----------|---------|--------|
| 11 | GetFunctionRecursionConfig | GET | `/api/lambda/2024-08-31/functions/{FunctionName}/recursion-config` | `lambda:GetFunctionRecursionConfig` | `functions.ts` | ✅ |

### Tagging

| # | Operation | API | Path Pattern | IAM Action | Handler | Status |
|----|-----------|-----|--------------|-----------|---------|--------|
| 12 | ListTags | GET | `/api/lambda/2017-03-31/tags/{FunctionArn}` | `lambda:ListTagsResource` | `functions.ts` | ✅ |

### Monitoring & Inspection

| # | Operation | API | Path Pattern | IAM Action | Handler | Status |
|----|-----------|-----|--------------|-----------|---------|--------|
| 13 | Inspect | GET | `/api/lambda/inspect` | `lambda:GetFunction` | `inspect/route.ts` | ✅ | Custom monitoring endpoint |

**Total Implemented**: 13 operations across 6 API versions

---

## Versioning Notes

Lambda API uses versioned endpoints:
- `2015-03-31`: Core function operations (oldest/most common)
- `2017-03-31`: Tagging support
- `2019-09-30`: Concurrency controls
- `2020-06-30`: Code signing configuration
- `2024-08-31`: Recursion detection (anti-loop prevention)

All versions are supported simultaneously. The correct version is determined by the request path.

---

## Not Yet Implemented

| # | Operation | Reason | Priority | Notes |
|----|-----------|--------|----------|-------|
| 1 | CreateAlias | Function aliasing | P1 | Useful for version management |
| 2 | DeleteAlias | Function aliasing | P1 | Pairs with CreateAlias |
| 3 | UpdateAlias | Function aliasing | P1 | Pairs with CreateAlias |
| 4 | GetAlias | Function aliasing | P1 | Pairs with CreateAlias |
| 5 | ListAliases | Function aliasing | P1 | Pairs with CreateAlias |
| 6 | PublishVersion | Function versioning | P1 | Create immutable function versions |
| 7 | UpdateFunctionConfiguration | Configuration updates | P1 | Separate from code updates |
| 8 | CreateEventSourceMapping | Event sources | P2 | Lambda triggers from other AWS services |
| 9 | DeleteEventSourceMapping | Event sources | P2 | Pairs with CreateEventSourceMapping |
| 10 | UpdateEventSourceMapping | Event sources | P2 | Pairs with CreateEventSourceMapping |
| 11 | GetEventSourceMapping | Event sources | P2 | Pairs with CreateEventSourceMapping |
| 12 | ListEventSourceMappings | Event sources | P2 | Query event source configurations |
| 13 | AddPermission | Function policy | P2 | Grant cross-account permissions |
| 14 | RemovePermission | Function policy | P2 | Revoke cross-account permissions |
| 15 | GetPolicy | Function policy | P2 | Read resource-based policy |
| 16 | PutFunctionConcurrency | Concurrency limits | P1 | Set reserved concurrency |
| 17 | DeleteFunctionConcurrency | Concurrency limits | P1 | Remove reserved concurrency |

**Note**: Version and aliasing support would enable blue-green deployments and traffic shifting. Event sources enable Lambda to react to S3, DynamoDB, SNS events. These are lower priority than core function operations.

---

## Common Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `AuthFailure` | 401 | Authentication failed or credentials invalid |
| `UnauthorizedOperation` | 403 | Principal lacks required IAM permission |
| `InvalidParameterValueException` | 400 | Invalid parameter in request |
| `MissingParameter` | 400 | Required parameter missing |
| `ResourceNotFoundException` | 404 | Function or resource does not exist |
| `ServiceException` | 502 | Service error during execution |
| `TooManyRequestsException` | 429 | Concurrency limit exceeded |
| `InvalidZipFileException` | 400 | ZIP file is invalid or corrupt |
| `RecursionDetected` | 400 | Function recursion detected (anti-loop) |
| `ENILimitReachedException` | 500 | Cannot create VPC ENI (network limit) |

---

## Lambda Network Integration

### Automatic ENI Lifecycle

When a Lambda function is configured with VPC access (VpcConfig):

1. **ENI Creation** (during Invoke):
   - Lambda creates temporary ENI(s) in the specified VPC/subnet
   - ENI uses the configured security groups
   - ENI IP is assigned from subnet CIDR block

2. **ENI Visibility**:
   - ENI appears in EC2 `DescribeNetworkInterfaces` responses
   - ENI is tagged with `aws:cloudformation:stack-name = lambda`

3. **ENI Deletion** (automatic):
   - ENI is deleted when NO Lambda functions use that (subnet, security group) combination
   - Prevents orphaned network interfaces from accumulating
   - Enables safe cleanup after Lambda removal

### Network Analysis Integration

The network analysis layer (`src/app/analysis/network/`) models Lambda network connectivity:
- Traces routes from Lambda ENI to target resources
- Validates security group rules are permissive
- Reports reachability evidence (can Lambda reach resource X?)

**Example**:
```json
{
  "type": "lambda",
  "source": "arn:aws:lambda:us-east-1:123456789012:function:my-function",
  "vpcConfig": {
    "subnetIds": ["subnet-abc123"],
    "securityGroupIds": ["sg-def456"]
  },
  "eni": {
    "id": "eni-12345678",
    "privateIp": "10.0.1.42",
    "subnet": "subnet-abc123"
  },
  "reachability": {
    "rds": "reachable",
    "s3": "reachable",
    "internet": "not reachable (no NAT)"
  }
}
```

---

## Function Configuration Parameters

### Required Parameters
- **FunctionName** (string): Name or ARN of the function (must be unique in account/region)
- **Role** (string): IAM execution role ARN
- **Handler** (string): Function entry point (e.g., `index.handler`)
- **Code** (object): Code location (ZipFile or S3Bucket/S3Key)
- **Runtime** (string): Execution runtime (nodejs20.x, python3.11, etc.)

### Optional Parameters
- **Description** (string): Function description
- **Timeout** (integer): Max execution time in seconds (default 3, max 900)
- **MemorySize** (integer): Memory allocation (128-10240 MB, default 128)
- **VpcConfig** (object): VPC configuration (SubnetIds, SecurityGroupIds)
  - When set, Lambda creates ENIs for network access
  - Required for accessing VPC resources (RDS, private ElastiCache, etc.)
- **Environment** (object): Environment variables
- **Tags** (object): Resource tags

---

## Implementation Details

### Handler Organization
```
src/app/api/lambda/
├─ service.ts              (defineService + operation registry)
├─ route.ts                (Next.js API route handler)
├─ functions.ts            (Core function operations)
├─ invoke.ts               (Invocation logic)
├─ logging.ts              (CloudWatch logging integration)
├─ protocol.ts             (REST/JSON protocol)
├─ code.ts                 (Code storage & management)
├─ zip.ts                  (ZIP file utilities)
├─ errors.ts               (Lambda-specific error codes)
├─ network.ts              (VPC/ENI management)
├─ inspect/route.ts        (Custom monitoring endpoint)
├─ 2015-03-31/functions/   (Core API endpoints)
├─ 2017-03-31/tags/        (Tagging endpoints)
├─ 2019-09-30/functions/   (Concurrency endpoints)
├─ 2020-06-30/functions/   (Code signing endpoints)
└─ 2024-08-31/functions/   (Recursion config endpoints)
```

### State Management
- **Storage**: `src/app/api/data/lambda/` (functions, configurations, code, ENI mappings)
- **Pattern**: State loaded per request, modified in-memory, saved after validation
- **ENI Lifecycle**: Tracked separately from Lambda functions (shared across functions)

### Network Interface Management
```typescript
// Simplified from network.ts
function createENIsIfNeeded(functionArn, vpcConfig) {
  const key = `${vpcConfig.subnets.join(',')},${vpcConfig.securityGroups.join(',')}`
  const existingENI = findENIByKey(key)
  if (existingENI) {
    // Reuse existing ENI
    incrementRefCount(existingENI)
  } else {
    // Create new ENI
    const eni = ec2.createNetworkInterface({
      subnetId: vpcConfig.subnets[0], // Primary subnet
      groups: vpcConfig.securityGroups,
      tags: [{ Key: 'aws:cloudformation:stack-name', Value: 'lambda' }]
    })
    recordENI(key, eni, 1)
  }
}

function deleteENIsIfUnused(functionArn, vpcConfig) {
  const key = `${vpcConfig.subnets.join(',')},${vpcConfig.securityGroups.join(',')}`
  decrementRefCount(key)
  if (refCount(key) === 0) {
    // No more Lambda functions use this ENI combo
    const eni = findENIByKey(key)
    ec2.deleteNetworkInterface(eni.id)
    deleteENIRecord(key)
  }
}
```

---

## Testing

### Unit Tests
Location: `src/app/api/__tests__/lambda.test.ts`

Test coverage includes:
- Function creation with different runtimes
- Function invocation (sync and async)
- Code update operations
- VPC configuration and ENI lifecycle
- Recursion detection (anti-loop)
- Concurrency limits

Run tests:
```bash
npm test -- lambda.test.ts
```

### Network Integration Tests
Location: `src/app/api/__tests__/network-live.test.ts` (includes Lambda ENI scenarios)

Tests Lambda network connectivity:
- Lambda can reach resources in same VPC
- Lambda cannot reach resources when security groups block
- ENI is created on first invocation
- ENI is deleted when no Lambda uses it

Run tests:
```bash
npm test -- network-live.test.ts
```

### Integration Tests (Terraform)
Location: `tests/terraform/services/lambda.tf`

Tests end-to-end Lambda operations:
```bash
cd tests/terraform
terraform apply -target=module.lambda_tests
```

---

## Examples

### Create a Function
```bash
curl -X POST http://localhost:3000/api/lambda/2015-03-31/functions \
  -H "Content-Type: application/json" \
  -d '{
    "FunctionName": "my-function",
    "Runtime": "python3.11",
    "Role": "arn:aws:iam::123456789012:role/lambda-exec-role",
    "Handler": "index.handler",
    "Code": {
      "ZipFile": "base64-encoded-zip"
    },
    "Timeout": 30,
    "MemorySize": 256
  }'

# Response
{
  "FunctionName": "my-function",
  "FunctionArn": "arn:aws:lambda:us-east-1:123456789012:function:my-function",
  "Runtime": "python3.11",
  "Role": "arn:aws:iam::123456789012:role/lambda-exec-role",
  "Handler": "index.handler",
  "CodeSize": 1234,
  "Timeout": 30,
  "MemorySize": 256,
  "CodeSha256": "abc123...",
  "LastModified": "2026-11-12T09:04:40.000+00:00",
  "State": "Active"
}
```

### Create Function with VPC Access
```bash
curl -X POST http://localhost:3000/api/lambda/2015-03-31/functions \
  -H "Content-Type: application/json" \
  -d '{
    "FunctionName": "my-db-function",
    "Runtime": "nodejs20.x",
    "Role": "arn:aws:iam::123456789012:role/lambda-exec-role",
    "Handler": "index.handler",
    "Code": { "ZipFile": "..." },
    "VpcConfig": {
      "SubnetIds": ["subnet-abc123"],
      "SecurityGroupIds": ["sg-def456"]
    }
  }'

# ENI is automatically created during first invocation
```

### Invoke a Function
```bash
curl -X POST http://localhost:3000/api/lambda/2015-03-31/functions/my-function/invocations \
  -H "Content-Type: application/json" \
  -d '{ "key": "value" }'

# Response
{
  "StatusCode": 200,
  "Payload": "{\"result\": \"success\"}"
}
```

### List Functions
```bash
curl -X GET http://localhost:3000/api/lambda/2015-03-31/functions

# Response
{
  "Functions": [
    {
      "FunctionName": "my-function",
      "FunctionArn": "arn:aws:lambda:us-east-1:123456789012:function:my-function",
      "Runtime": "python3.11",
      ...
    }
  ]
}
```

---

## Related Services

- **Network Analysis**: `src/app/analysis/network/` (ENI and reachability modeling)
- **EC2 Integration**: Lambda creates/deletes ENIs via EC2 network interface operations
- **IAM**: Lambda execution role governs what resources the function can access
- **CloudWatch**: Logging integration for Lambda execution logs
- **Authorization**: `src/app/auth/policy/` (IAM permission checks)

---

## Recent Changes

### Phase 1 Refactoring (Nov 2026)
- Moved Lambda execution runtime to `src/lib/lambda-runtime/`
- Lambda service implementation remains in `src/app/api/lambda/`
- Network analysis integration points updated

### Phase 2 Standardization (In Progress)
- Creating uniform README documentation
- Standardizing operation definitions
- Adding comprehensive network integration tests
- Planning recursive invocation safety improvements

---

## Known Limitations

1. **No Alias Support**: Versioning aliases not yet implemented (P1 for next phase)
2. **Simple Event Handling**: No event source mappings (P2)
3. **No Layer Support**: Lambda layers not yet implemented (P2)
4. **Basic Recursion Detection**: Anti-loop check is simple (improvement needed)

---

## Next Steps

1. Complete service standardization across IAM, S3, KMS
2. Add Terraform integration test framework
3. Implement Transit Gateway for cross-account Lambda-to-Lambda calls
4. Add VPC Flow Logs to trace Lambda network traffic

---

## Questions?

Check `/docs/REFACTORING_READY_TO_START.md` for broader context or review test files for usage examples.
