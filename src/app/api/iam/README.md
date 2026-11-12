# IAM API Reference

**Service IAM Prefix**: `iam`  
**Protocol**: Query (XML-based AWS Query Protocol v2010-05-08)  
**Documentation**: [AWS IAM API Reference](https://docs.aws.amazon.com/IAM/latest/APIReference/)

---

## Overview

The IAM (Identity and Access Management) service manages users, roles, and permissions within AWS accounts. In this simulator, IAM provides:
- User creation, configuration, and deletion
- Role creation and management
- Policy creation and attachment
- Permission granting and revocation
- Cross-account assume-role relationships
- Organization-level Service Control Policies (SCPs)

**Key Integration**: IAM policies are evaluated by the policy engine (`src/app/auth/policy/`) for all service operations. The `principal` from the request context is validated against resource and identity-based policies.

---

## Implemented Operations

### User Management

| # | Operation | HTTP | Path | IAM Action | Handler | Status |
|----|-----------|------|------|-----------|---------|--------|
| 1 | CreateUser | POST | `/api/iam` | `iam:CreateUser` | `users.ts` | ✅ |
| 2 | DeleteUser | POST | `/api/iam` | `iam:DeleteUser` | `users.ts` | ✅ |
| 3 | GetUser | POST | `/api/iam` | `iam:GetUser` | `users.ts` | ✅ |
| 4 | ListUsers | POST | `/api/iam` | `iam:ListUsers` | `users.ts` | ✅ |
| 5 | UpdateUser | POST | `/api/iam` | `iam:UpdateUser` | `users.ts` | ✅ |
| 6 | CreateAccessKey | POST | `/api/iam` | `iam:CreateAccessKey` | `users.ts` | ✅ |
| 7 | DeleteAccessKey | POST | `/api/iam` | `iam:DeleteAccessKey` | `users.ts` | ✅ |
| 8 | ListAccessKeys | POST | `/api/iam` | `iam:ListAccessKeys` | `users.ts` | ✅ |

### Role Management

| # | Operation | HTTP | Path | IAM Action | Handler | Status |
|----|-----------|------|------|-----------|---------|--------|
| 9 | CreateRole | POST | `/api/iam` | `iam:CreateRole` | `roles.ts` | ✅ |
| 10 | DeleteRole | POST | `/api/iam` | `iam:DeleteRole` | `roles.ts` | ✅ |
| 11 | GetRole | POST | `/api/iam` | `iam:GetRole` | `roles.ts` | ✅ |
| 12 | ListRoles | POST | `/api/iam` | `iam:ListRoles` | `roles.ts` | ✅ |
| 13 | UpdateAssumeRolePolicy | POST | `/api/iam` | `iam:UpdateAssumeRolePolicy` | `roles.ts` | ✅ |
| 14 | AssumeRole | POST | `/api/iam` | `sts:AssumeRole` | `roles.ts` | ✅ |

### Policy Management

| # | Operation | HTTP | Path | IAM Action | Handler | Status |
|----|-----------|------|------|-----------|---------|--------|
| 15 | CreatePolicy | POST | `/api/iam` | `iam:CreatePolicy` | `policies.ts` | ✅ |
| 16 | DeletePolicy | POST | `/api/iam` | `iam:DeletePolicy` | `policies.ts` | ✅ |
| 17 | GetPolicy | POST | `/api/iam` | `iam:GetPolicy` | `policies.ts` | ✅ |
| 18 | ListPolicies | POST | `/api/iam` | `iam:ListPolicies` | `policies.ts` | ✅ |
| 19 | AttachUserPolicy | POST | `/api/iam` | `iam:AttachUserPolicy` | `policies.ts` | ✅ |
| 20 | AttachRolePolicy | POST | `/api/iam` | `iam:AttachRolePolicy` | `policies.ts` | ✅ |
| 21 | DetachUserPolicy | POST | `/api/iam` | `iam:DetachUserPolicy` | `policies.ts` | ✅ |
| 22 | DetachRolePolicy | POST | `/api/iam` | `iam:DetachRolePolicy` | `policies.ts` | ✅ |
| 23 | GetUserPolicy | POST | `/api/iam` | `iam:GetUserPolicy` | `policies.ts` | ✅ |
| 24 | GetRolePolicy | POST | `/api/iam` | `iam:GetRolePolicy` | `policies.ts` | ✅ |
| 25 | ListUserPolicies | POST | `/api/iam` | `iam:ListUserPolicies` | `policies.ts` | ✅ |
| 26 | ListRolePolicies | POST | `/api/iam` | `iam:ListRolePolicies` | `policies.ts` | ✅ |
| 27 | PutUserPolicy | POST | `/api/iam` | `iam:PutUserPolicy` | `policies.ts` | ✅ |
| 28 | PutRolePolicy | POST | `/api/iam` | `iam:PutRolePolicy` | `policies.ts` | ✅ |
| 29 | DeleteUserPolicy | POST | `/api/iam` | `iam:DeleteUserPolicy` | `policies.ts` | ✅ |
| 30 | DeleteRolePolicy | POST | `/api/iam` | `iam:DeleteRolePolicy` | `policies.ts` | ✅ |

**Total Implemented**: 30 operations

---

## Not Yet Implemented

| # | Operation | Reason | Priority |
|----|-----------|--------|----------|
| 1 | CreateGroup | User groups | P2 | Useful for bulk permission management |
| 2 | DeleteGroup | User groups | P2 | Pairs with CreateGroup |
| 3 | AddUserToGroup | User groups | P2 | Pairs with CreateGroup |
| 4 | GetGroup | User groups | P2 | Pairs with CreateGroup |
| 5 | ListGroups | User groups | P2 | Pairs with CreateGroup |
| 6 | CreateInstance Profile | Instance profiles | P1 | Needed for EC2 instance roles |
| 7 | AddRoleToInstanceProfile | Instance profiles | P1 | Pairs with CreateInstance Profile |
| 8 | AttachInstanceProfile | Instance profiles | P1 | Pairs with CreateInstance Profile |
| 9 | GenerateServiceAccessKey | Service credentials | P2 | Programmatic access for services |
| 10 | ListAccountAliases | Account info | P2 | Account name management |
| 11 | CreateManagedPolicy | Policy versioning | P1 | More flexible than inline policies |
| 12 | GetPolicyVersion | Policy versioning | P1 | Pairs with CreateManagedPolicy |
| 13 | ListPolicyVersions | Policy versioning | P1 | Pairs with CreateManagedPolicy |

**Note**: 
- **Service Control Policies (SCPs)**: Planned for later integration with organizational controls
- **Instance Profiles**: Needed for EC2 instances to assume roles (P1 for EC2 integration)
- **Managed Policies**: Would enable policy versioning and better reuse

---

## Common Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `AuthFailure` | 401 | Authentication failed |
| `AccessDenied` | 403 | Principal lacks required IAM permission |
| `ValidationError` | 400 | Invalid parameter or policy document |
| `NoSuchEntity` | 404 | User, role, or policy does not exist |
| `EntityAlreadyExists` | 400 | User, role, or policy already exists |
| `DeleteConflict` | 400 | Cannot delete (has dependent policies/attachments) |
| `MalformedPolicyDocument` | 400 | Policy JSON is invalid |
| `InvalidPolicyVersion` | 400 | Policy version does not exist |
| `ServiceFailure` | 502 | Service error (internal) |

---

## IAM Policy Structure

### Policy Document Format
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "service:Operation",
      "Resource": "arn:aws:service:region:account:resource"
    }
  ]
}
```

### Assume Role Policy (Trust Relationship)
Used when creating a role to define who can assume it:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

---

## Implementation Details

### Handler Organization
```
src/app/api/iam/
├─ service.ts              (defineService + operation registry)
├─ route.ts                (Next.js API route handler)
├─ users.ts                (User operations)
├─ roles.ts                (Role operations)
├─ policies.ts             (Policy operations & attachments)
```

### State Management
- **Storage**: `src/app/api/data/iam/` (users, roles, policies, attachments)
- **Pattern**: Query protocol operations parse XML, load state, modify in-memory, save changes
- **Pagination**: Operations support Marker-based pagination (not yet implemented - P1)

### Policy Evaluation
The policy engine (`src/app/auth/policy/`) evaluates all operations:
1. Extract principal ARN from request context
2. Load identity-based policies attached to user/role
3. Load resource-based policies for target resource (if applicable)
4. Check if any policy Allows the requested action+resource
5. Return Allow or Deny

---

## Testing

### Unit Tests
Location: `src/app/api/__tests__/iam.test.ts`

Test coverage includes:
- User CRUD operations
- Role creation and assume role
- Policy creation and attachment
- Permission enforcement
- Cross-account assume role scenarios

Run tests:
```bash
npm test -- iam.test.ts
```

### Integration Tests (Terraform)
Location: `tests/terraform/services/iam.tf`

Tests end-to-end IAM operations:
```bash
cd tests/terraform
terraform apply -target=module.iam_tests
```

---

## Examples

### Create a User
```bash
curl -X POST http://localhost:3000/api/iam \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d 'Action=CreateUser&UserName=alice'

# Response (XML)
<CreateUserResponse>
  <CreateUserResult>
    <User>
      <UserName>alice</UserName>
      <UserId>AIDAI1234567890ABCDE</UserId>
      <Arn>arn:aws:iam::123456789012:user/alice</Arn>
      <CreateDate>2026-11-12T09:04:40Z</CreateDate>
    </User>
  </CreateUserResult>
</CreateUserResponse>
```

### Create a Role
```bash
curl -X POST http://localhost:3000/api/iam \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode 'Action=CreateRole' \
  --data-urlencode 'RoleName=lambda-exec-role' \
  --data-urlencode 'AssumeRolePolicyDocument={
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }'
```

### Attach Policy to User
```bash
curl -X POST http://localhost:3000/api/iam \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode 'Action=AttachUserPolicy' \
  --data-urlencode 'UserName=alice' \
  --data-urlencode 'PolicyArn=arn:aws:iam::aws:policy/AmazonEC2FullAccess'
```

### Assume Role
```bash
curl -X POST http://localhost:3000/api/iam \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode 'Action=AssumeRole' \
  --data-urlencode 'RoleArn=arn:aws:iam::123456789012:role/lambda-exec-role' \
  --data-urlencode 'RoleSessionName=lambda-session'

# Response
<AssumeRoleResponse>
  <AssumeRoleResult>
    <Credentials>
      <AccessKeyId>ASIA...</AccessKeyId>
      <SecretAccessKey>...</SecretAccessKey>
      <SessionToken>...</SessionToken>
      <Expiration>2026-11-12T10:04:40Z</Expiration>
    </Credentials>
  </AssumeRoleResult>
</AssumeRoleResponse>
```

---

## Related Services

- **Policy Engine**: `src/app/auth/policy/` (evaluates all IAM policies)
- **Authorization**: All services check IAM permissions before executing operations
- **Data Layer**: `src/app/api/data/iam/` (state storage)

---

## Recent Changes

### Phase 1 Refactoring (Nov 2026)
- Moved policy evaluation to `src/app/auth/policy/`
- IAM service implementation remains in `src/app/api/iam/`

### Phase 2 Standardization (In Progress)
- Creating uniform README documentation
- Standardizing operation definitions
- Planning Service Control Policies (SCPs) integration

---

## Next Steps

1. Complete service standardization across S3, KMS
2. Add Terraform integration test framework
3. Implement Instance Profiles (needed for EC2 role integration)
4. Add Service Control Policies (SCPs) for organizational controls

---

## Questions?

Check `/docs/REFACTORING_READY_TO_START.md` for broader context or review test files for usage examples.
