# Service Control Policies (SCPs) Integration Roadmap

## Current Status: ✅ IMPLEMENTED (Not Yet Integrated into Network Analysis)

### What's Already Built

The **Organizations** service already has complete support for SCPs:

| Feature | Status | Location |
|---------|--------|----------|
| Policy type management | ✅ Done | `src/app/api/db/organizations.ts` |
| Enable/Disable policy types | ✅ Done | `EnablePolicyType`, `DisablePolicyType` handlers |
| Create/Delete/Update policies | ✅ Done | Organizations API |
| Attach/Detach to targets | ✅ Done | Policy attachment to accounts/OUs |
| Describe effective policies | ✅ Done | `DescribeEffectivePolicy` |
| Default allow-all policy | ✅ Done | Created automatically when SCP type enabled |

**Supported Policy Types** (from `POLICY_TYPES` array):
- `SERVICE_CONTROL_POLICY` (SCP) ← the one we care about for networking
- `RESOURCE_CONTROL_POLICY` (RCP)
- `TAG_POLICY`
- `BACKUP_POLICY`
- And 8 others (AWS-managed policies)

### What's NOT Yet Integrated

SCPs are **not yet considered** during network trace analysis:

1. ❌ Network trace doesn't check if SCP blocks the action
2. ❌ No "SCP denies this" evidence type
3. ❌ Cross-account traces assume full permission
4. ❌ VPC Flow Logs don't capture SCP decisions

---

## Integration Plan

### Phase 4.2: Cross-Account Network Trace (Foundation)

**Prerequisite:** VPC Peering Connections working

Before we can trace across accounts, we need:
- ✅ Peering connection model (not yet built)
- ✅ Cross-account route resolution
- ✅ Target account EC2 state loading

**At this stage, SCPs are:**
- Ignored (assume allow-all)
- But the infrastructure for checking them is ready

### Phase 5: VPC Flow Logs (Optional SCP Integration)

**Integration Point 1: Policy Evaluation in Traces**

When a network trace reaches a cross-account boundary:

```typescript
// reach.ts pseudo-code
function traceCrossAccount(packet, peeringId) {
  // 1. Load target account's EC2 state
  const targetState = loadState(targetAccount, region)
  
  // 2. NEW: Check if organization has SCPs enabled
  const org = loadOrganization()
  if (org.policyTypes.includes(SCP)) {
    // 3. NEW: Evaluate effective policy for the cross-account action
    const effectivePolicy = describeEffectivePolicy({
      account: targetAccount,
      principal: 'AWS::PrincipalType::Account', // sender account
      action: 'ec2:SendNetworkPacket' // pseudo-action
    })
    
    if (effectivePolicy.denies(action)) {
      return {
        status: 'denied',
        reason: 'SERVICE_CONTROL_POLICY',
        policy: effectivePolicy.id
      }
    }
  }
  
  // 4. Continue normal trace (SGs, NACLs, etc)
  return continueTrace(packet, targetState)
}
```

**Integration Point 2: Evidence Type**

Add `'service-control-policy'` to `Evidence.kind` union:

```typescript
// trace.ts
type Evidence = 
  | { kind: 'route'; ... }
  | { kind: 'security-group'; ... }
  | { kind: 'network-acl'; ... }
  | { kind: 'service-control-policy'; policyId: string; effect: 'Deny' }
  // ↑ New
  | { kind: 'blackhole'; ... }
```

**Integration Point 3: VPC Flow Logs Records**

Extend CloudWatch Logs records with SCP details:

```json
{
  "version": 2,
  "account-id": "123456789012",
  "action": "DENY",
  "flow-logs-status": "OK",
  "packet-srcaddr": "10.0.0.1",
  "packet-dstaddr": "10.1.0.1",
  "policy-evaluation": {
    "type": "SERVICE_CONTROL_POLICY",
    "policy-id": "p-xxxxxxxxxx",
    "effect": "Deny",
    "principal": "123456789013"
  }
}
```

---

## Implementation Steps

### Step 1: VPC Peering (Phase 4.2)
- [ ] Create `src/app/api/ec2/peering.ts`
- [ ] Add peering connection model
- [ ] Implement CreateVpcPeeringConnection, AcceptVpcPeeringConnection
- [ ] Add peering as route target
- [ ] Implement cross-account route resolution

### Step 2: Cross-Account Network Analysis (Phase 4.2 cont.)
- [ ] Extend `reach.ts` to load target account state
- [ ] Implement `traceCrossAccountRoute()`
- [ ] Test routing through peered VPCs

### Step 3: SCP Evaluation in Traces (Phase 5+ or 6)
- [ ] Add `'service-control-policy'` to Evidence type
- [ ] Implement `evaluateOrganizationPolicy()` function
- [ ] Call it in `traceCrossAccountRoute()` when org has SCPs
- [ ] Add SCP denial evidence to trace output

### Step 4: VPC Flow Logs with SCP Details (Phase 5 cont.)
- [ ] Extend CloudWatch Logs record format
- [ ] Capture policy evaluation details
- [ ] Add query filter for "denied by SCP"

---

## Current Blockers

1. **VPC Peering not modeled yet**
   - Can't trace across accounts without it
   - Phase 4.2 needs to build this first

2. **DescribeEffectivePolicy not yet used in analysis**
   - API exists, but network code doesn't call it
   - Need helper function to evaluate if action is allowed

3. **Cross-account state loading needs multi-account context**
   - Currently network trace is single-account
   - Need to extend context to include target account credentials

---

## Example: What It Will Look Like

### Before (Phase 4.1)
```
Route: 10.1.0.0/16 → pcx-abc123
Status: REACHABLE
Evidence:
  - Requester VPC route: points to peering
  - Peering connection: ACTIVE
  (Assumes target account allows it)
```

### After (Phase 5+)
```
Route: 10.1.0.0/16 → pcx-abc123
Status: DENIED (by SCP)
Evidence:
  - Requester VPC route: points to peering
  - Peering connection: ACTIVE
  - Service Control Policy: DENIED
    * Policy: p-xxxxxxxxxx (attached to target OU)
    * Effect: Deny
    * Action: ec2:CreateNetworkInterface (assumed)
    * Principal: arn:aws:iam::123456789012:root
```

---

## Why SCPs Aren't Integrated Yet

1. **Complexity increases exponentially**
   - Need to model principal (who is making the call?)
   - Need to model the specific action (DescribeSecurityGroups? CreateNetworkInterface?)
   - Need to evaluate policy in cross-account context
   - AWS policy evaluation is non-trivial

2. **Requires cross-account coordination**
   - Currently each account is isolated
   - Cross-account requires loading both accounts' org policies
   - Adds authentication/authorization complexity

3. **Lower priority than basic connectivity**
   - Phase 4 is about "can traffic flow?"
   - Phase 5+ is about "why doesn't traffic flow?"
   - SCPs are a "why not?" answer

4. **Can be added incrementally**
   - Once peering works, SCP evaluation is optional enhancement
   - Network traces work fine without it
   - Can add later without breaking existing traces

---

## Recommended Approach

**Phase 4.2:** Get VPC peering and cross-account traces working
- Focus on: Do routes work?
- Ignore: What policies restrict it?

**Phase 5:** Integrate SCPs (optional refinement)
- When user enables SCP policy type in org
- Network trace automatically shows SCP denials
- VPC Flow Logs capture policy details

**Phase 6+:** Advanced policy analysis
- "What if I attach this SCP?" (policy simulation)
- "Which SCPs are currently blocking this traffic?" (reverse lookup)
- Cross-organization policy analysis

This keeps complexity manageable while building on solid foundations.
