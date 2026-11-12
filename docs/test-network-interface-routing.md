# Testing Network Interface Routing (Phase 4)

## Quick Test: Route to Lambda Interface

This demonstrates that routes can now target network interfaces and the network analysis shows the Lambda interface in the trace.

### Prerequisites
1. Create a VPC and subnet
2. Create a Lambda function with VPC configuration
3. The Lambda function will have a shared network interface created automatically

### Test Steps

```bash
# 1. Start the dev server
npm run dev

# 2. Create Lambda function via CLI or Terraform
# The function will automatically get a network interface

# 3. Get the network interface ID
curl -X POST http://localhost:3000/api/ec2 \
  -d "Action=DescribeNetworkInterfaces&Filter.1.Name=description&Filter.1.Values.1=AWS Lambda*" \
  -H "Content-Type: application/x-www-form-urlencoded"

# Returns: NetworkInterfaceId (e.g., eni-abc123)

# 4. Create a route to the network interface
# Add a route table entry: 10.0.0.0/8 -> eni-xxxxx

# 5. Test network reach through the interface
curl -X POST http://localhost:3000/api/network/inspect \
  -H "Content-Type: application/json" \
  -d '{
    "account": "390209512651",
    "region": "eu-central-1",
    "from": { "subnetId": "subnet-xxx", "securityGroupIds": ["sg-xxx"] },
    "to": { "host": "10.0.1.1", "port": 443 }
  }'
```

### Expected Output in Trace

1. **Route phase**: Shows the route points to the network interface
   ```
   "summary": "routed to network interface eni-abc123 (Lambda)"
   "phase": "route"
   "decision": "info"
   ```

2. **Security group phase**: Shows the interface's own security groups are checked
   ```
   "summary": "egress allowed by sg-lambda: tcp to 10.0.0.0/8"
   "phase": "security-group-out"
   ```

3. **Delivery**: Confirms the packet reaches the interface
   ```
   "phase": "delivery"
   "decision": "allow"
   "summary": "delivered to network interface eni-abc123"
   ```

## Automatic Cleanup Test

When all Lambda functions that need an interface are deleted:

```bash
# 1. Delete all Lambda functions using the subnet+security-group combo
# 2. Call DescribeNetworkInterfaces
# 3. The interface is automatically deleted
```

The network trace will show:
```json
{
  "phase": "route",
  "decision": "deny",
  "cause": "blackhole-route",
  "summary": "network interface eni-abc123 does not exist"
}
```

This demonstrates that:
- Interfaces are auto-cleaned when no functions need them
- The network model stays consistent with Lambda state
- Stale routes automatically become blackholes

## What Changed

- Route targets can now be `NetworkInterfaceId`
- The route's effective state depends on the interface's status
- Network traces show which interface type (Lambda, NAT gateway, etc.)
- Requester-managed interfaces have their security group rules checked
- Lambda interface creation/deletion is automatic and atomic
