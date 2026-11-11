# Next Steps: Logging as Network Call (Final Step)

## Current Status

Most of Option A is **already completed**:

✅ Step 1: Move invocation records to data/
- Complete: `db/<account>/<region>/data/lambda-invocations/<function>.json`
- Per-function JSONL storage, separate from lambda.json state

✅ Step 3: UpdateFunctionCode operation
- Complete: `src/app/api/lambda/service.ts`
- Code directory replacement works

✅ Step 2: IAM enforcement on function calls
- 95% complete: Authorization framework in place, role policies evaluated
- Small gap: cross-service calls from Lambda don't have explicit permission checks (SigV4 still verifies identity)

## What's Remaining: Step 4

### Logging as Network Call

This is the final piece that makes logging respect the network model.

**Current behavior:**
```
Lambda code writes to stdout/stderr
  ↓
run.ts captures directly
  ↓
deliverLog() checks permissions
  ↓
Log written (if permissions allow)
```

**New behavior:**
```
Lambda code writes to stdout/stderr
  ↓
netshim.py captures via stdout.write() interception
  ↓
netshim sends {'op': 'log_write', 'messages': [...]} to runner
  ↓
run.ts simulates logs.put_log_events() call through network model
  ↓
Network model evaluates: can Lambda reach CloudWatch?
  ↓
If reachable: permission check + write
If not: log dropped, reason recorded
```

### Why This Matters

Completes the walking skeleton promise: "Let the network model decide what happens."

Right now:
- Variant A (no route): Lambda can't reach STS, but **CAN log** ❌ wrong
- Variant B (with NAT): Lambda can reach STS via NAT, logs work ✓
- Variant C (SG blocks): Lambda can't reach STS, but **CAN log** ❌ wrong
- Variant D (NAT deleted): Lambda can't reach STS, but **CAN log** ❌ wrong

After logging-as-network-call:
- Variant A: Lambda can't log (no route to CloudWatch)
- Variant B: Lambda logs work (goes through NAT)
- Variant C: Lambda can't log (SG blocks CloudWatch)
- Variant D: Lambda can't log (NAT is gone)

### Implementation

See `logging-as-network-call-implementation.md` for detailed steps.

**Quick summary:**
1. Modify netshim.py to intercept stdout/stderr and send log_write messages (1-2 days)
2. Modify run.ts to receive log_write and simulate PutLogEvents call (1-2 days)
3. Modify logging.ts to accept network decision and check network first (1 day)
4. Add tests for all variants with logging (2-3 days)
5. Debug and finalize (1-2 days)

**Total: ~5-7 days**

## Decision: Ready to Start?

The implementation plan is complete and ready to execute. All infrastructure is in place:
- ✓ decide() function for network evaluation
- ✓ Message protocol between shim and runner
- ✓ Permission checking framework
- ✓ Invocation record storage
- ✓ Tests exist for existing scenarios

You're just connecting these pieces for logging.

