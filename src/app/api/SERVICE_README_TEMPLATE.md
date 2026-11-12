# [SERVICE_NAME] API Reference

**Service IAM Prefix**: `[service]`  
**Protocol**: [Query/REST/JSON/XML]  
**Documentation**: [Link to AWS docs if applicable]

---

## Overview

Brief description of what this service does and its role in the simulator.

### Key Features
- Feature 1
- Feature 2
- Feature 3

---

## Implemented Operations

| # | Operation | HTTP | Path | IAM Action | Handler | Status |
|----|-----------|------|------|-----------|---------|--------|
| 1 | Operation1 | POST | `/api/[service]` | `[service]:Operation1` | `operation1.ts` | ✅ |
| 2 | Operation2 | GET | `/api/[service]?Action=Operation2` | `[service]:Operation2` | `operation2.ts` | ✅ |

**Total Implemented**: X operations

### Operation Details

#### Operation1
- **Description**: What does it do
- **IAM Action**: `[service]:Operation1`
- **Required Parameters**: 
  - `Parameter1` (string): Description
  - `Parameter2` (number): Description
- **Response Fields**:
  - `ResponseField1` (string): Description
  - `ResponseField2` (object[]): Description
- **Error Codes**: `InvalidParameter`, `AuthFailure`, etc.
- **Example**:
  ```bash
  curl -X POST http://localhost:3000/api/[service] \
    -H "Content-Type: application/json" \
    -d '{ "Action": "Operation1", "Parameter1": "value" }'
  ```
  **Response**:
  ```json
  { "ResponseField1": "value", "ResponseField2": [] }
  ```

---

## Not Yet Implemented

| # | Operation | Reason | Priority |
|----|-----------|--------|----------|
| 1 | FutureOp1 | Not in initial scope | P1 |
| 2 | FutureOp2 | Blocked by infrastructure work | P2 |

**Note**: These operations are listed in AWS documentation but are not yet implemented in this simulator. They would require additional state management or external integration.

---

## Common Error Codes

| Code | HTTP Status | Meaning | Handling |
|------|-------------|---------|----------|
| `AuthFailure` | 401 | Authentication failed or credentials invalid | Check credentials and IAM permissions |
| `UnauthorizedOperation` | 403 | Principal lacks required IAM permission | Add permission to IAM policy |
| `InvalidParameter.* ` | 400 | Invalid parameter value | Check parameter format and constraints |
| `ResourceNotFound` | 404 | Requested resource does not exist | Verify resource ID is correct |
| `ServiceUnavailable` | 503 | Service temporarily unavailable | Region disabled or internal error |

---

## IAM Permission Reference

To call [SERVICE_NAME] operations, principals need:

### Minimal Policy (Single Operation)
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "[service]:Operation1",
      "Resource": "*"
    }
  ]
}
```

### Full Service Access
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "[service]:*",
      "Resource": "*"
    }
  ]
}
```

### Resource-Specific Access (if applicable)
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "[service]:*",
      "Resource": "arn:[partition]:[service]:[region]:[account]:resource/[name]"
    }
  ]
}
```

---

## Testing

### Unit Tests
Location: `src/app/api/__tests__/[service].test.ts`

Run tests:
```bash
npm test -- [service].test.ts
```

### Integration Tests
Location: `tests/terraform/services/[service].tf`

Run integration tests:
```bash
cd tests/terraform
terraform apply -target=module.[service]_tests
```

---

## Implementation Notes

### Handler Pattern
All operations follow the standardized pattern:
```typescript
import { defineService } from "../registry"
import { handler1, handler2 } from "./handlers"

export const [service] = defineService({
  iamPrefix: '[service]',
  protocol: new [Protocol](),
  operations: {
    Operation1: { handler: handler1, action: '[service]:Operation1' },
    Operation2: { handler: handler2, action: '[service]:Operation2' },
  },
})
```

### State Management
- **Stateful Operations**: Operations that modify state go through `loadState()` / `saveState()`
- **DryRun Support**: All write operations support `DryRun` parameter (validated but not persisted)
- **Region Enforcement**: Operations validate that the region is enabled for the account

### Error Handling
- **Validation**: Parameter validation happens before database operations
- **Authorization**: IAM policy engine validates all operations (see `src/app/auth/policy/`)
- **Transformation**: AWS errors use the `AwsError` class for consistent formatting

---

## Related Services

- **Common Layer**: `src/app/api/common/`
- **Data Layer**: `src/app/api/data/`
- **Auth Layer**: `src/app/auth/policy/`
- **Network Analysis**: `src/app/analysis/network/` (for network-aware operations)

---

## Changelog

### Latest Updates
- [Date] - [Description of changes]

---

## Questions?

Check the main codebase documentation at `/docs/` or review the test files for usage examples.
