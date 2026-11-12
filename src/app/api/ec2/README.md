# EC2 API Reference

**Service IAM Prefix**: `ec2`  
**Protocol**: REST with Query-style parameters  
**Documentation**: [AWS EC2 API Reference](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/)

---

## Overview

The EC2 (Elastic Compute Cloud) service provides network infrastructure simulation and management capabilities. In this simulator, EC2 handles:
- VPC (Virtual Private Cloud) creation and management
- Subnet management within VPCs
- Security groups and network ACLs for access control
- Internet gateways and routing tables for network topology
- Network interfaces and Elastic IPs for workload connectivity
- NAT gateways for outbound connectivity
- VPC endpoints for service access
- Resource tagging for organization

**Key Integration**: EC2 operations are deeply integrated with the network analysis layer (`src/app/analysis/network/`) which models network reachability and traffic flows.

---

## Implemented Operations

| # | Operation | HTTP | Path | IAM Action | State | Notes |
|---|-----------|------|------|-----------|-------|-------|
| **VPC Management** |
| 1 | CreateVpc | POST | `/api/ec2` | `ec2:CreateVpc` | ✅ W | Mutates state |
| 2 | DeleteVpc | POST | `/api/ec2` | `ec2:DeleteVpc` | ✅ W | Cascade deletes subnets |
| 3 | DescribeVpcs | POST | `/api/ec2` | `ec2:DescribeVpcs` | ✅ R | Read-only |
| 4 | ModifyVpcAttribute | POST | `/api/ec2` | `ec2:ModifyVpcAttribute` | ✅ W | EnableDnsHostnames, EnableDnsSupport |
| 5 | DescribeVpcAttribute | POST | `/api/ec2` | `ec2:DescribeVpcAttribute` | ✅ R | Read-only |
| 6 | AssociateVpcCidrBlock | POST | `/api/ec2` | `ec2:AssociateVpcCidrBlock` | ✅ W | Associate secondary CIDR |
| 7 | DisassociateVpcCidrBlock | POST | `/api/ec2` | `ec2:DisassociateVpcCidrBlock` | ✅ W | Remove CIDR association |
| 8 | CreateDefaultVpc | POST | `/api/ec2` | `ec2:CreateDefaultVpc` | ✅ W | Create AWS-default VPC |
| **Subnet Management** |
| 9 | CreateSubnet | POST | `/api/ec2` | `ec2:CreateSubnet` | ✅ W | Mutates state |
| 10 | DeleteSubnet | POST | `/api/ec2` | `ec2:DeleteSubnet` | ✅ W | Checks no network interfaces |
| 11 | DescribeSubnets | POST | `/api/ec2` | `ec2:DescribeSubnets` | ✅ R | Read-only |
| 12 | ModifySubnetAttribute | POST | `/api/ec2` | `ec2:ModifySubnetAttribute` | ✅ W | MapPublicIpOnLaunch |
| 13 | CreateDefaultSubnet | POST | `/api/ec2` | `ec2:CreateDefaultSubnet` | ✅ W | Create default subnet in AZ |
| **Security Groups** |
| 14 | CreateSecurityGroup | POST | `/api/ec2` | `ec2:CreateSecurityGroup` | ✅ W | Mutates state |
| 15 | DeleteSecurityGroup | POST | `/api/ec2` | `ec2:DeleteSecurityGroup` | ✅ W | Checks no references |
| 16 | DescribeSecurityGroups | POST | `/api/ec2` | `ec2:DescribeSecurityGroups` | ✅ R | Read-only |
| 17 | AuthorizeSecurityGroupIngress | POST | `/api/ec2` | `ec2:AuthorizeSecurityGroupIngress` | ✅ W | Add ingress rules |
| 18 | AuthorizeSecurityGroupEgress | POST | `/api/ec2` | `ec2:AuthorizeSecurityGroupEgress` | ✅ W | Add egress rules |
| 19 | RevokeSecurityGroupIngress | POST | `/api/ec2` | `ec2:RevokeSecurityGroupIngress` | ✅ W | Remove ingress rules |
| 20 | RevokeSecurityGroupEgress | POST | `/api/ec2` | `ec2:RevokeSecurityGroupEgress` | ✅ W | Remove egress rules |
| 21 | ModifySecurityGroupRules | POST | `/api/ec2` | `ec2:ModifySecurityGroupRules` | ✅ W | Modify rule descriptions |
| 22 | UpdateSecurityGroupRuleDescriptionsIngress | POST | `/api/ec2` | `ec2:UpdateSecurityGroupRuleDescriptionsIngress` | ✅ W | Update descriptions |
| 23 | UpdateSecurityGroupRuleDescriptionsEgress | POST | `/api/ec2` | `ec2:UpdateSecurityGroupRuleDescriptionsEgress` | ✅ W | Update descriptions |
| 24 | DescribeSecurityGroupRules | POST | `/api/ec2` | `ec2:DescribeSecurityGroupRules` | ✅ R | Query individual rules |
| **Network ACLs** |
| 25 | CreateNetworkAcl | POST | `/api/ec2` | `ec2:CreateNetworkAcl` | ✅ W | Mutates state |
| 26 | DeleteNetworkAcl | POST | `/api/ec2` | `ec2:DeleteNetworkAcl` | ✅ W | Only if not default |
| 27 | CreateNetworkAclEntry | POST | `/api/ec2` | `ec2:CreateNetworkAclEntry` | ✅ W | Add ACL rule |
| 28 | ReplaceNetworkAclEntry | POST | `/api/ec2` | `ec2:ReplaceNetworkAclEntry` | ✅ W | Modify ACL rule |
| 29 | DeleteNetworkAclEntry | POST | `/api/ec2` | `ec2:DeleteNetworkAclEntry` | ✅ W | Remove ACL rule |
| 30 | ReplaceNetworkAclAssociation | POST | `/api/ec2` | `ec2:ReplaceNetworkAclAssociation` | ✅ W | Change ACL for subnet |
| 31 | DescribeNetworkAcls | POST | `/api/ec2` | `ec2:DescribeNetworkAcls` | ✅ R | Read-only |
| **Routing** |
| 32 | CreateRouteTable | POST | `/api/ec2` | `ec2:CreateRouteTable` | ✅ W | Mutates state |
| 33 | DeleteRouteTable | POST | `/api/ec2` | `ec2:DeleteRouteTable` | ✅ W | Only if not main |
| 34 | CreateRoute | POST | `/api/ec2` | `ec2:CreateRoute` | ✅ W | Add route to table |
| 35 | ReplaceRoute | POST | `/api/ec2` | `ec2:ReplaceRoute` | ✅ W | Modify route |
| 36 | DeleteRoute | POST | `/api/ec2` | `ec2:DeleteRoute` | ✅ W | Remove route |
| 37 | AssociateRouteTable | POST | `/api/ec2` | `ec2:AssociateRouteTable` | ✅ W | Associate table with subnet |
| 38 | DisassociateRouteTable | POST | `/api/ec2` | `ec2:DisassociateRouteTable` | ✅ W | Disassociate table |
| 39 | ReplaceRouteTableAssociation | POST | `/api/ec2` | `ec2:ReplaceRouteTableAssociation` | ✅ W | Change association |
| 40 | DescribeRouteTables | POST | `/api/ec2` | `ec2:DescribeRouteTables` | ✅ R | Read-only |
| **Internet Gateways** |
| 41 | CreateInternetGateway | POST | `/api/ec2` | `ec2:CreateInternetGateway` | ✅ W | Mutates state |
| 42 | DeleteInternetGateway | POST | `/api/ec2` | `ec2:DeleteInternetGateway` | ✅ W | Only if not attached |
| 43 | AttachInternetGateway | POST | `/api/ec2` | `ec2:AttachInternetGateway` | ✅ W | Attach to VPC |
| 44 | DetachInternetGateway | POST | `/api/ec2` | `ec2:DetachInternetGateway` | ✅ W | Detach from VPC |
| 45 | DescribeInternetGateways | POST | `/api/ec2` | `ec2:DescribeInternetGateways` | ✅ R | Read-only |
| **NAT Gateways** |
| 46 | CreateNatGateway | POST | `/api/ec2` | `ec2:CreateNatGateway` | ✅ W | Requires Elastic IP |
| 47 | DeleteNatGateway | POST | `/api/ec2` | `ec2:DeleteNatGateway` | ✅ W | Mutates state |
| 48 | DescribeNatGateways | POST | `/api/ec2` | `ec2:DescribeNatGateways` | ✅ R | Read-only |
| **Elastic IPs** |
| 49 | AllocateAddress | POST | `/api/ec2` | `ec2:AllocateAddress` | ✅ W | Mutates state |
| 50 | ReleaseAddress | POST | `/api/ec2` | `ec2:ReleaseAddress` | ✅ W | Only if not associated |
| 51 | DisassociateAddress | POST | `/api/ec2` | `ec2:DisassociateAddress` | ✅ W | Remove from resource |
| 52 | DescribeAddresses | POST | `/api/ec2` | `ec2:DescribeAddresses` | ✅ R | Read-only |
| **VPC Endpoints** |
| 53 | CreateVpcEndpoint | POST | `/api/ec2` | `ec2:CreateVpcEndpoint` | ✅ W | Gateway or Interface types |
| 54 | DeleteVpcEndpoint | POST | `/api/ec2` | `ec2:DeleteVpcEndpoint` | ✅ W | Remove endpoint |
| 55 | DescribeVpcEndpoints | POST | `/api/ec2` | `ec2:DescribeVpcEndpoints` | ✅ R | Read-only |
| 56 | ModifyVpcEndpoint | POST | `/api/ec2` | `ec2:ModifyVpcEndpoint` | ✅ W | Change configuration |
| **Network Interfaces** |
| 57 | DescribeNetworkInterfaces | POST | `/api/ec2` | `ec2:DescribeNetworkInterfaces` | ✅ R | Read-only; includes Lambda ENIs |
| **DHCP Options** |
| 58 | DescribeDhcpOptions | POST | `/api/ec2` | `ec2:DescribeDhcpOptions` | ✅ R | Read-only |
| **Tags** |
| 59 | CreateTags | POST | `/api/ec2` | `ec2:CreateTags` | ✅ W | Tag any resource |
| 60 | DeleteTags | POST | `/api/ec2` | `ec2:DeleteTags` | ✅ W | Remove tags |
| 61 | DescribeTags | POST | `/api/ec2` | `ec2:DescribeTags` | ✅ R | Query tags |
| **Account & Region Info** |
| 62 | DescribeAccountAttributes | POST | `/api/ec2` | `ec2:DescribeAccountAttributes` | ✅ R | Account attribute values |
| 63 | DescribeRegions | POST | `/api/ec2` | `ec2:DescribeRegions` | ✅ R | Enabled/disabled regions |
| 64 | DescribeAvailabilityZones | POST | `/api/ec2` | `ec2:DescribeAvailabilityZones` | ✅ R | AZs in enabled regions |

**Total Implemented**: 64 operations

**W** = Writes/mutates state (requires `saveState()`)  
**R** = Read-only operations (no state mutation)

---

## Not Yet Implemented

| # | Operation | Reason | Priority |
|---|-----------|--------|----------|
| 1 | CreateNetworkInterface | Direct ENI creation | P1 | Lambda creates these automatically for network connectivity |
| 2 | DeleteNetworkInterface | Direct ENI deletion | P1 | Lambda deletes these when no longer needed |
| 3 | AttachNetworkInterface | Manual ENI attachment | P2 | Mostly handled by Lambda integration |
| 4 | DetachNetworkInterface | Manual ENI detachment | P2 | Mostly handled by Lambda integration |
| 5 | CreateTransitGateway | Cross-account connectivity | P0 | Coming in Phase 2 |
| 6 | AttachTransitGateway | Cross-account peering | P0 | Coming in Phase 2 |
| 7 | CreateVpcPeeringConnection | VPC peering | P1 | Lower priority than Transit Gateways |
| 8 | AcceptVpcPeeringConnection | VPC peering | P1 | Lower priority than Transit Gateways |

**Note**: 
- **Lambda ENI Operations**: Lambda automatically creates network interfaces as needed and deletes them when no longer used. This is modeled through the network analysis layer rather than explicit EC2 operations.
- **Transit Gateways**: Planned for Phase 2 (higher priority than VPC peering for cross-account connectivity).
- **VPC Peering**: Deprioritized in favor of Transit Gateways as the primary cross-account connectivity solution.

---

## Common Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `AuthFailure` | 401 | Authentication failed or region disabled |
| `UnauthorizedOperation` | 403 | Principal lacks required IAM permission |
| `InvalidParameterValue` | 400 | Invalid parameter in request |
| `MissingParameter` | 400 | Required parameter missing |
| `InvalidVpcID.NotFound` | 404 | VPC ID does not exist |
| `InvalidSubnetID.NotFound` | 404 | Subnet ID does not exist |
| `InvalidSecurityGroupID.NotFound` | 404 | Security group ID does not exist |
| `InvalidRouteTableID.NotFound` | 404 | Route table ID does not exist |
| `VpcCidrConflict` | 400 | CIDR block conflicts with existing |
| `SubnetConflict` | 400 | Subnet CIDR overlaps with existing |
| `DependencyViolation` | 400 | Resource cannot be deleted (has dependencies) |
| `DryRunOperation` | 412 | DryRun succeeded; no actual change |

---

## Implementation Details

### State Management
- **State File**: `src/app/api/data/ec2/state.ts` (loaded and saved per request)
- **Pattern**: 
  ```typescript
  const state = loadState({ account, region })
  const result = operation(state, context)
  saveState({ account, region }, state)
  ```
- **DryRun**: All write operations validate but throw `DryRunOperation` error instead of saving state

### Network Integration
- **Network Analysis**: EC2 operations are analyzed by `src/app/analysis/network/` to model reachability
- **Lambda ENI Lifecycle**: 
  - ENIs created when Lambda function invokes with network connectivity
  - ENIs deleted when no Lambda with that security group + subnet combination exists
  - See `src/app/api/network/inspect/route.ts` for integration point
- **Evidence**: Network reachability evidence is generated from EC2 configuration

### Handler Organization
- **File Structure**:
  ```
  src/app/api/ec2/
  ├─ service.ts          (defineService + operation registry)
  ├─ route.ts            (Next.js API route handler)
  ├─ protocol.ts         (Query protocol implementation)
  ├─ vpc.ts              (VPC operations)
  ├─ subnet.ts           (Subnet operations)
  ├─ securitygroup.ts    (Security group operations)
  ├─ routetable.ts       (Routing operations)
  ├─ networkacl.ts       (ACL operations)
  ├─ internetgateway.ts  (IGW operations)
  ├─ natgateway.ts       (NAT gateway operations)
  ├─ address.ts          (Elastic IP operations)
  ├─ vpcendpoint.ts      (VPC endpoint operations)
  ├─ describes.ts        (Multi-describe operations)
  ├─ tags.ts             (Tagging operations)
  ├─ account.ts          (Account/region info)
  ├─ request.ts          (Request type definitions)
  ├─ model.ts            (Data models)
  └─ ec2.md              (Documentation)
  ```

### Error Handling Pattern
```typescript
function operation(op: Op, mutates: boolean): Handler {
  return ctx => {
    const scope = { account: ctx.account, region: ctx.region }
    // 1. Validate region
    if (getRegion(scope.account, scope.region) === 'DISABLED') {
      throw new AwsError('AuthFailure', ...)
    }
    // 2. Load state
    const state = loadState(scope)
    // 3. Execute operation
    const result = op(state, { scope, principal: ctx.principal, params: ctx.params })
    // 4. Check DryRun
    if (ctx.params.DryRun) throw DRY_RUN_OPERATION()
    // 5. Save state if mutated
    if (mutates) saveState(scope, state)
    return result
  }
}
```

---

## Testing

### Unit Tests
Location: `src/app/api/__tests__/ec2.test.ts`

Test coverage includes:
- VPC CRUD operations
- Subnet validation and cascade deletion
- Security group rule management
- Routing table and route management
- Network ACL rules
- Internet gateway attachment/detachment
- NAT gateway lifecycle

Run tests:
```bash
npm test -- ec2.test.ts
```

### Network Integration Tests
Location: `src/app/api/__tests__/network.test.ts`

Tests that EC2 configuration changes are reflected in network analysis:
- Scenario A: Simple EC2 connectivity
- Scenario B: Multi-VPC setup
- Scenario C: Security group enforcement
- Scenario D: Route table impact

Run tests:
```bash
npm test -- network.test.ts
```

### Integration Tests (Terraform)
Location: `tests/terraform/services/ec2.tf`

Tests end-to-end EC2 operations:
```bash
cd tests/terraform
terraform apply -target=module.ec2_tests
```

---

## Examples

### Create a VPC and Subnet
```bash
# Create VPC
curl -X POST http://localhost:3000/api/ec2 \
  -H "Content-Type: application/json" \
  -d '{
    "Action": "CreateVpc",
    "CidrBlock": "10.0.0.0/16"
  }'

# Response
{
  "Vpc": {
    "VpcId": "vpc-12345",
    "CidrBlock": "10.0.0.0/16",
    "IsDefault": false,
    "State": "available"
  }
}

# Create Subnet
curl -X POST http://localhost:3000/api/ec2 \
  -H "Content-Type: application/json" \
  -d '{
    "Action": "CreateSubnet",
    "VpcId": "vpc-12345",
    "CidrBlock": "10.0.1.0/24",
    "AvailabilityZone": "us-east-1a"
  }'

# Response
{
  "Subnet": {
    "SubnetId": "subnet-67890",
    "VpcId": "vpc-12345",
    "CidrBlock": "10.0.1.0/24",
    "State": "available"
  }
}
```

### Create Security Group with Rules
```bash
# Create security group
curl -X POST http://localhost:3000/api/ec2 \
  -H "Content-Type: application/json" \
  -d '{
    "Action": "CreateSecurityGroup",
    "GroupName": "my-sg",
    "Description": "My security group",
    "VpcId": "vpc-12345"
  }'

# Add ingress rule (allow port 443)
curl -X POST http://localhost:3000/api/ec2 \
  -H "Content-Type: application/json" \
  -d '{
    "Action": "AuthorizeSecurityGroupIngress",
    "GroupId": "sg-abc123",
    "IpProtocol": "tcp",
    "FromPort": 443,
    "ToPort": 443,
    "CidrIp": "0.0.0.0/0"
  }'
```

---

## Related Services

- **Network Analysis**: `src/app/analysis/network/` (reachability modeling)
- **Lambda Integration**: Lambda uses EC2 to create network interfaces for VPC connectivity
- **Authorization**: `src/app/auth/policy/` (IAM permission checks)
- **Data Layer**: `src/app/api/data/ec2/` (state persistence)

---

## Recent Changes

### Phase 1 Refactoring (Nov 2026)
- Moved network analysis layer to `src/app/analysis/network/`
- EC2 operates remain in `src/app/api/ec2/`
- Network integration points updated to new analysis layer

### Phase 2 Standardization (In Progress)
- Creating uniform README documentation
- Standardizing operation definitions
- Adding Terraform integration tests
- Planning Transit Gateway implementation

---

## Next Steps

1. **Phase 2.1**: Complete service standardization across Lambda, IAM, S3, KMS
2. **Phase 2.2**: Create Terraform integration test framework
3. **Phase 2.3**: Implement Transit Gateway support (cross-account connectivity)
4. **Phase 2.4**: Add VPC Flow Logs for network debugging

---

## Questions?

Check `/docs/REFACTORING_READY_TO_START.md` for broader context or review test files for usage examples.
