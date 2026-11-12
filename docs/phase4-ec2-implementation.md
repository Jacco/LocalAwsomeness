# Phase 4 EC2 Network Implementation Summary

## Completed: Network Interfaces in Network Analysis ✅

### What was implemented:
1. **Enhanced RouteTarget type** (routes.ts)
   - Added `{ kind: 'network-interface'; id: string }` to RouteTarget union type
   - Removed NetworkInterfaceId from OTHER_TARGETS (now explicitly handled)

2. **Effective Route State** (routes.ts)
   - Added case for network-interface targets
   - Checks interface exists and status is 'in-use'
   - Returns 'active' or 'blackhole' based on interface availability

3. **Network Trace Evidence** (trace.ts)
   - Added 'network-interface' to Evidence.kind union type
   - Allows network interfaces to appear in trace evidence

4. **Network Reach Handler** (reach.ts)
   - Added `NetworkInterfacePath` interface
   - Added `networkInterfaceStep()` function to handle interface routing
   - Added dispatch logic for network-interface route targets
   - Traces through interface's security groups and NACLs
   - Recognizes Lambda interfaces (InterfaceType === 'lambda')
   - Reports when interfaces are requester-managed

### How it works:
When a route points to a NetworkInterfaceId:
1. The route target is identified as 'network-interface'
2. The interface is checked for existence and 'in-use' status
3. The network trace examines:
   - The interface's own security groups (for Lambda-managed or other service interfaces)
   - The interface's subnet NACLs
   - The interface type and ownership status

### Lambda Interface Auto-Cleanup ✅ (Already Working)

The Lambda interface auto-cleanup is already fully implemented:
- **Triggered by**: Lambda function create, delete, and updateCode operations
- **Location**: `lambda/functions.ts` calls `reconcileInterfaces()` at lifecycle events
- **How it works**: 
  - Scans all functions to find which subnet+security-group combinations are needed
  - Deletes interfaces for combinations nobody needs anymore
  - Creates new interfaces for new combinations
  - Simulates AWS's automatic cleanup of unused Lambda ENIs

The cleanup happens transparently:
- If all Lambda functions leave a VPC, the shared interface disappears automatically
- New functions in the same VPC reuse existing interfaces or create new ones
- Traffic traces will show 'blackhole' if the interface was cleaned up

## TODO: Gateway Attachments for Cross-Account ⏳

### Phase 4 Part 2 - Gateway Attachments Model

Currently not modelled: Cross-account network traffic requires VPC Peering Connections.

**What needs to be added**:

1. **VPC Peering Connections** (new peering.ts)
   - Create/Delete/Describe operations
   - Requester accepts/rejects peering
   - Track attachment state between accounts

2. **Network Analysis Enhancement** (reach.ts extension)
   - When route target is `VpcPeeringConnectionId`
   - Check if connection is in 'active' state
   - Allow traffic to cross account boundary
   - Apply rules of destination VPC

3. **Multi-Account State**
   - Load EC2 state from target account
   - Query target VPC's route tables, NACLs, security groups
   - Return full trace through both sides

### Not Yet: Transit Gateways, Endpoints
- Interface endpoints: create shared interfaces like Lambda does
- Gateway endpoints: S3 and DynamoDB
- Transit gateways: later phase, more complex

## TODO: VPC Flow Logs (Phase 5) 📋

### Specification (for future implementation):

VPC Flow Logs will provide packet-level evidence of what the network model decided.

**Design**:
1. **Trigger**: Every successful or failed network traversal
2. **Record Format**: Standard AWS VPC Flow Logs fields
   - version, account-id, interface-id, srcaddr, dstaddr, srcport, dstport
   - protocol, packets, bytes, windowstart, windowend
   - action (ACCEPT/REJECT), flow-logs-status

3. **Storage**: CloudWatch Logs integration
   - Log group: `/aws/vpc/flowlogs/{vpcId}`
   - Log streams: per subnet or interface
   - Query via CloudWatch Logs Insights

4. **Phases Recorded**:
   - security-group-out: where decision was made
   - nacl-out: which rule/reason
   - route: which route matched
   - nat-gateway: translated address
   - internet-gateway: public address
   - nacl-in: return path decision
   - delivery: final outcome

5. **Integration Points**:
   - Network trace in reach.ts: capture each step
   - Integration test: verify flow matches trace
   - Dashboard: visualize flows by interface

**Example Query**:
```
fields srcaddr, dstaddr, action, protocol, dstport
| stats count() as packet_count by action, protocol
```

## Implementation Checklist

- [x] Network interfaces as route targets
- [x] Lambda interface recognition in traces
- [x] Lambda interface auto-cleanup (already working)
- [ ] VPC Peering Connections data model
- [ ] Cross-account network trace
- [ ] VPC Flow Logs capture
- [ ] VPC Flow Logs CloudWatch integration
- [ ] Flow Logs query/visualization

## Testing Notes

The network interface implementation is tested via:
1. `src/app/api/__tests__/network-live.test.ts` - interface source resolution
2. Routes to network interfaces can be tested with: `POST /api/network/inspect`
   - Create a Lambda function in a VPC
   - Query to the function's interface via its private IP
   - Trace shows Lambda interface and security group checks

Example test scenario:
```bash
# 1. Create Lambda function with VPC config
# 2. Get its network interface from DescribeNetworkInterfaces
# 3. Create a route table entry: 10.0.0.0/8 -> eni-xxxxx
# 4. Test reach from a subnet: can reach 10.0.1.100:443?
# Expected: Trace shows interface routing, Lambda SG check, NACL check
```

