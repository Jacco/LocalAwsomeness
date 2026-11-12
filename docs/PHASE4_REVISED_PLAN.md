# Phase 4 EC2 Network Implementation - Revised Plan

## Current Status
**Phase 4.1 ✅ COMPLETE:** Network Interfaces as Route Targets
- Network interfaces now recognized as first-class route targets
- Lambda interface lifecycle working correctly
- Network traces validated through interfaces

---

## Phase 4.2: Transit Gateway for Cross-Account Connectivity

### Why Transit Gateway First?

1. **More Common in Production**
   - Enterprise standard for multi-account AWS
   - Scales better than 1-to-1 peering

2. **Enables On-Premises Connectivity**
   - VPN attachments
   - Direct Connect gateway integration
   - Foundation for hybrid networks

3. **Cleaner Route Table Logic**
   - Single TGW route target
   - No bilateral accept/reject dance like peering
   - Better for network analysis

4. **Simpler to Model Initially**
   - Hub-and-spoke is straightforward
   - Can add peering later as refinement

### Phase 4.2 Scope: Transit Gateway Core

#### Data Model (new file: `src/app/api/ec2/gateways.ts`)

```typescript
export interface TransitGateway {
  TransitGatewayId: string
  State: 'pending' | 'available' | 'modifying' | 'deleting' | 'deleted'
  Description?: string
  OwnerId: string
  AmazonSideAsn: number
  Tags?: Tag[]
  TransitGatewayArn: string
  // Options (AWS has many, we'll support essentials):
  DefaultRouteTableAssociation: 'enable' | 'disable'
  DefaultRouteTablePropagation: 'enable' | 'disable'
  DnsSupport: 'enable' | 'disable'
  VpnEcnSupport: 'enable' | 'disable'
}

export interface TransitGatewayAttachment {
  TransitGatewayAttachmentId: string
  TransitGatewayId: string
  ResourceId: string  // VPC ID for VPC attachments
  ResourceType: 'vpc' | 'vpn' | 'direct-connect-gateway' | 'peering'
  State: 'pending' | 'pendingAcceptance' | 'roleBack' | 'available' | 'modifying' | 'deleting' | 'deleted'
  Association?: {
    TransitGatewayRouteTableId: string
    State: 'associating' | 'associated' | 'disassociating' | 'disassociated'
  }
  Tags?: Tag[]
  // For VPC attachments:
  SubnetIds?: string[]  // Which subnets are attached
  VpcId?: string
}

export interface TransitGatewayRouteTable {
  TransitGatewayRouteTableId: string
  TransitGatewayId: string
  State: 'pending' | 'available' | 'deleting' | 'deleted'
  DefaultAssociationRouteTable: boolean
  DefaultPropagationRouteTable: boolean
  Tags?: Tag[]
}

export interface TransitGatewayRoute {
  DestinationCidrBlock: string
  State: 'blackhole' | 'active'
  Type: 'static' | 'propagated'
  TransitGatewayAttachmentId?: string  // Points to attachment if not blackhole
  RouteOrigin?: 'CreateTransitGatewayRoute' | 'CreateVpcPeeringConnection' | 'CreateCustomerGatewayRoute'
}
```

#### Operations to Implement

```typescript
// TGW Management
CreateTransitGateway(description?, tags?, options?)
DeleteTransitGateway(id)
DescribeTransitGateways()
ModifyTransitGatewayOptions()

// Attachments
CreateTransitGatewayVpcAttachment(tgwId, vpcId, subnetIds, tags?)
DeleteTransitGatewayAttachment(attachmentId)
DescribeTransitGatewayAttachments()
ModifyTransitGatewayVpcAttachment()

// Route Tables (within a TGW)
CreateTransitGatewayRouteTable(tgwId, tags?)
DeleteTransitGatewayRouteTable(rtId)
DescribeTransitGatewayRouteTables()
SearchTransitGatewayRoutes()

// Routes
CreateTransitGatewayRoute(rtId, cidr, attachmentId)
DeleteTransitGatewayRoute(rtId, cidr)
ReplaceTransitGatewayRoute()

// Association/Propagation
AssociateTransitGatewayRouteTable(rtId, attachmentId)
DisassociateTransitGatewayRouteTable(rtId, attachmentId)
EnableTransitGatewayRouteTablePropagation(rtId, attachmentId)
DisableTransitGatewayRouteTablePropagation(rtId, attachmentId)
```

### Network Analysis Integration

#### 1. Route Target Enhancement

Add TGW as route target in `routes.ts`:

```typescript
type RouteTarget = 
  | { kind: 'internet-gateway'; id: string }
  | { kind: 'nat-gateway'; id: string }
  | { kind: 'network-interface'; id: string }
  | { kind: 'transit-gateway'; id: string }  // NEW
  | { kind: 'vpc-peering'; id: string }      // Future
  | { kind: 'local'; }
  | { kind: 'blackhole' }
```

#### 2. Network Trace for TGW

In `reach.ts`, add transit gateway tracing:

```typescript
interface TransitGatewayPath extends Path {
  kind: 'transit-gateway'
  tgwId: string
  attachmentId: string
  tgwRouteTableId: string
  tgwRoute: TransitGatewayRoute
  // Destination side (after TGW)
  targetAttachment?: TransitGatewayAttachment
  targetVpc?: string
  targetSubnets?: Subnet[]
}

function transitGatewayStep(ctx: TraceContext, tgw: TransitGateway, ...): TransitGatewayPath {
  // 1. Check TGW exists and is 'available'
  if (tgw.State !== 'available') return { kind: 'blackhole', reason: `TGW state: ${tgw.State}` }
  
  // 2. Find route table association for this attachment
  const routeTable = findAssociatedRouteTable(tgw, sourceAttachment)
  if (!routeTable) return { kind: 'blackhole', reason: 'No route table association' }
  
  // 3. Look up the destination route in the TGW route table
  const tgwRoute = findRoute(routeTable, packet.destination)
  if (!tgwRoute || tgwRoute.State === 'blackhole') {
    return { kind: 'blackhole', reason: 'TGW route blackhole' }
  }
  
  // 4. If route points to an attachment, resolve to target VPC
  if (tgwRoute.TransitGatewayAttachmentId) {
    const targetAttachment = getAttachment(tgwRoute.TransitGatewayAttachmentId)
    if (targetAttachment.ResourceType === 'vpc') {
      // Continue trace in target VPC
      const targetVpc = loadVpc(targetAttachment.VpcId, packet.targetAccount)
      return continueInTargetVpc(packet, targetVpc, targetAttachment)
    }
  }
  
  return { kind: 'blackhole', reason: 'Unhandled attachment type' }
}
```

#### 3. Cross-Account Networking

When route points to TGW in same account:
- Look up attachment to see if it's cross-account
- Load target VPC/account from attachment
- Continue trace in target account

```typescript
// In reach.ts dispatch logic
case 'transit-gateway':
  const tgw = getTransitGateway(target.id)
  const path = transitGatewayStep(ctx, tgw)
  if (path.kind === 'blackhole') {
    evidence.push(path)
  } else if (path.kind === 'transit-gateway' && path.targetVpc) {
    // Cross-account or same-account via TGW
    const targetState = loadEc2State(path.targetAccount || ctx.account, ctx.region)
    return continueTrace(packet, targetState, path)
  }
  break
```

### Data Storage

Add TGW state to EC2 state model:

```typescript
// src/app/api/db/ec2/state.ts
export interface Ec2State {
  // ... existing ...
  transitGateways: Record<string, TransitGateway>
  transitGatewayAttachments: Record<string, TransitGatewayAttachment>
  transitGatewayRouteTables: Record<string, TransitGatewayRouteTable>
  transitGatewayRoutes: Record<string, TransitGatewayRoute>  // Global lookup by route ID
}
```

### Testing Strategy

1. **Unit Tests**
   - TGW CRUD operations
   - Route resolution through TGW
   - Attachment state transitions

2. **Network Analysis Tests**
   - Single-account TGW routing
   - Cross-account routing through TGW
   - Blackhole scenarios (missing attachment, invalid route)

3. **Integration Tests**
   - Create VPC → Create TGW → Create attachment → Create route → Trace packet
   - Verify packet reaches destination account

### Deliverables

- [ ] `src/app/api/ec2/gateways.ts` - TGW model and operations
- [ ] Update `src/app/api/db/ec2/state.ts` for TGW storage
- [ ] Update `src/app/api/network/routes.ts` for TGW target type
- [ ] Update `src/app/api/network/reach.ts` with `transitGatewayStep()`
- [ ] New TGW operations handlers in EC2 API
- [ ] Tests for TGW operations and cross-account routing
- [ ] Updated `src/app/api/ec2/ec2.md` documentation
- [ ] `docs/transit-gateway-guide.md` - Usage guide

### Why This Order?

1. **Foundation:** Network interfaces (Phase 4.1) ✅
2. **Next:** Transit Gateways (Phase 4.2) ← YOU ARE HERE
3. **Later:** VPC Peering (Phase 4.3)
4. **Then:** VPC Endpoints (Phase 4.4)
5. **Finally:** VPC Flow Logs (Phase 5)

---

## FAQ: Why Not SCPs?

**Q: Where do SCPs fit in this plan?**

A: SCPs don't tie into networking traffic flow. They're organizational access control:
- SCP blocks: "Can you call `CreateVpc` API?"
- Networking doesn't care about: "Did the API call succeed?"

SCPs are an IAM/governance layer, not a network connectivity layer. If you want to model "this account is restricted from creating resources," that belongs in:
- Organizations service (already done)
- IAM policy simulation (future)
- NOT in network routing/flow analysis

---

## Revised High-Level Roadmap

| Phase | Focus | Status |
|-------|-------|--------|
| 4.1 | Network interfaces as route targets | ✅ DONE |
| 4.2 | Transit Gateways (hub-and-spoke cross-account) | 🔲 NEXT |
| 4.3 | VPC Peering (point-to-point, optional) | 🔲 FUTURE |
| 4.4 | VPC Endpoints (S3, DynamoDB, custom services) | 🔲 FUTURE |
| 5 | VPC Flow Logs (network decision logging) | 🔲 FUTURE |
| 6+ | Advanced (policy simulation, multi-region routing) | 🔲 FUTURE |
