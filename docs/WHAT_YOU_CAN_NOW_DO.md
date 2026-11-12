# Phase 4 EC2: What You Can Now Do

## 🎯 Network Interfaces in Analysis

You can now analyze network traffic that routes through network interfaces. This is critical for:
- **Lambda functions** with VPC configuration
- **NAT gateways** and their ENIs
- **AWS managed services** that use interfaces
- **Custom routes** to specific interfaces

## 📍 Practical Examples

### Example 1: Testing Lambda Connectivity

Before Phase 4:
```
Question: Can my Lambda reach this endpoint?
Answer: Unknown - network interface routing wasn't modelled
```

After Phase 4:
```
Question: Can my Lambda in vpc-123 reach 10.0.1.100:443?

Network Trace:
├ Route lookup: 10.0.0.0/8 → eni-lambda-shared (route table)
├ Interface check: eni-lambda-shared status = 'in-use' ✓
├ Security group: egress to 10.0.0.0/8 on tcp/443 ✓ (Lambda's SG)
├ Subnet NACL: ingress from 10.0.0.0/8 tcp/443 ✓
└ Delivery: SUCCESS to interface eni-lambda-shared

Why: Lambda's VPC interface is shared with other functions.
How: One interface per (subnet, security-group-set) combination.
Auto-cleanup: When no Lambda needs it, the interface disappears.
```

### Example 2: Custom Interface Route

Create a route to a specific network interface:

```bash
# Setup
vpc-id: vpc-12345
subnet-id: subnet-67890
route-table-id: rtb-abcdef

# Create a custom route
aws ec2 create-route \
  --route-table-id rtb-abcdef \
  --destination-cidr-block 172.16.0.0/12 \
  --network-interface-id eni-12345

# Test reach from subnet-67890 to any address in 172.16.0.0/12
curl -X POST http://localhost:3000/api/network/inspect \
  -H "Content-Type: application/json" \
  -d '{
    "from": { "subnetId": "subnet-67890", "securityGroupIds": ["sg-xxx"] },
    "to": { "host": "172.16.1.5", "port": 443 }
  }'

# Output shows:
# - Route matches the custom interface
# - Interface's security groups are checked
# - Subnet's NACL rules are applied
```

### Example 3: Monitor Lambda Interface Lifecycle

```bash
# 1. Create Lambda function
aws lambda create-function \
  --function-name my-func \
  --vpc-config SubnetIds=subnet-xxx,SecurityGroupIds=sg-xxx \
  ...

# Result: Network interface created automatically
# eni-lambda-my-func-abc123 with InterfaceType='lambda'

# 2. Create another Lambda with same subnet + SG
# Result: Reuses the same interface (shared architecture)

# 3. Delete first Lambda
# Result: Interface still exists (second Lambda uses it)

# 4. Delete second Lambda
# Result: Interface auto-deleted (no functions need it)

# 5. Query network interface route
# Result: Now returns 'blackhole' (interface no longer exists)
```

## 🔍 What the Network Trace Shows Now

### For Lambda Interfaces

```json
{
  "phase": "route",
  "summary": "routed to network interface eni-abc123 (Lambda)",
  "detail": [
    "Found: eni-abc123 is a Lambda-managed interface in subnet-67890",
    "Requester-managed interfaces have their own security group rules..."
  ],
  "evidence": [
    { "kind": "network-interface", "id": "eni-abc123", "name": "AWS Lambda VPC ENI-my-func-..." }
  ]
}
```

### For Any Interface Type

The trace will document:
- ✅ Interface exists
- ✅ Interface is in-use
- ✅ Interface's security groups
- ✅ Interface's subnet NACL rules
- ✅ Interface type (Lambda, NAT gateway, or custom)
- ✅ Whether it's requester-managed (AWS service owns it)

## 🚀 Enabling Your Use Cases

### Use Case 1: "Does my application reach all its dependencies?"

**Before**: Lambda connections were a black box
**After**: You can trace through Lambda's network interfaces, see which endpoints it can reach, and why connections fail

### Use Case 2: "What happens when a Lambda function's network config changes?"

**Before**: Manual interface lifecycle tracking needed
**After**: Automatic. Interfaces appear/disappear as functions change. Traces stay consistent.

### Use Case 3: "Can I route traffic through a custom interface?"

**Before**: No - interfaces were hidden from the routing model
**After**: Yes. Create routes to `NetworkInterfaceId`. Traces show the interface and its security rules.

### Use Case 4: "How do I debug network issues with Lambda?"

**Before**: Guessing at SG rules and NACL rules
**After**: Full trace shows exactly where traffic is blocked, with the specific rules/NACLs that deny it

## 📝 For Developers

### Adding Network Interface Routes

```typescript
// In the EC2 service code
const route = {
  DestinationCidrBlock: "10.0.0.0/8",
  NetworkInterfaceId: "eni-12345",  // Now supported!
  RouteTableId: "rtb-abc",
  State: "active"  // Derived from interface status
}
```

### Checking Interface Availability

```typescript
// routes.ts handles this automatically:
// If interface status changes, route becomes blackhole
// If interface is deleted, route becomes blackhole
// If interface is in-use, route is active
```

### Tracing Network Paths

```typescript
// reach.ts now handles the full flow:
// 1. Identify network-interface route target
// 2. Verify interface exists and status is 'in-use'
// 3. Apply interface's own security groups
// 4. Check interface's subnet NACLs
// 5. Report delivery or failure with details
```

## 🎓 What's Ready for Phase 4 Part 2

**Gateway Attachments** (VPC Peering Connections):
```
Your network trace can then show:
├ Route: 172.16.0.0/12 → pcx-12345 (peering)
├ Peering: active between account-A and account-B
├ Cross-account: transitioning to account-B's VPC
├ Destination SG: ingress tcp/443 from 10.0.0.0/8 ✓
└ Delivery: SUCCESS through peering connection
```

**VPC Flow Logs** (Phase 5):
```
CloudWatch Logs will record every packet decision:
Fields: srcaddr, dstaddr, srcport, dstport, action, protocol
Queries: "show me all rejected traffic from Lambda interfaces"
Debugging: "why did this packet fail at the security group check?"
```

---

## ✅ Summary

**Phase 4 Part 1** is complete:
- ✅ Network interfaces are route targets
- ✅ Lambda interfaces are recognized in traces
- ✅ Auto-cleanup is working (no code changes needed)
- ✅ Routes become blackhole when interfaces disappear
- ✅ All tests pass
- ✅ Production-ready

**You can now**:
1. Route traffic through network interfaces
2. Trace connections through Lambda VPC interfaces
3. See security group and NACL decisions at the interface level
4. Watch interfaces auto-create and auto-delete with Lambda functions
5. Debug connectivity issues with full visibility into interface-level rules

**Ready for next steps**:
1. ✅ Implement VPC Peering for cross-account
2. ✅ Add VPC Flow Logs for packet-level debugging
3. ✅ Add Transit Gateways for complex topologies
4. ✅ Add interface/gateway endpoints for AWS services
