# Implementation Status: Walking Skeleton Option A

You're right! Most of Option A has already been implemented. Here's the detailed status:

## ✅ Step 1: Move invocation records to data/
**Status: COMPLETE**
- Location: `db/<account>/<region>/data/lambda-invocations/<function>.json`
- Code: `src/app/api/db/lambda.ts` (functions `loadInvocations`, `saveInvocations`)
- Implementation: One file per function, invocations stored as JSONL (one per line)
- Tests: `src/app/api/__tests__/lambda.test.ts` confirms this works
- Verified: Separate from `lambda.json` state, as intended

## ✅ Step 3: UpdateFunctionCode operation
**Status: COMPLETE**
- Location: `src/app/api/lambda/service.ts` (handler: `updateFunctionCode`)
- Route: `PUT /lambda/2015-03-31/functions/[name]/code`
- Functionality: Replaces function code directory, removes old files
- Tests: `lambda.test.ts` has test "is replaced by UpdateFunctionCode, and the files of the old code are removed"
- Verified: Works as intended

## ✅ Step 2: IAM enforcement on function calls
**Status: PARTIALLY COMPLETE**

**What exists:**
- Authorization framework in place: `src/app/api/authorization.ts`
- `setAuthorizer()` and `authorize()` functions for policy enforcement
- `identityAuthorizer` from `src/app/api/policy/authorizer.ts` evaluates role policies
- Logging.ts uses `accessDenial()` to check permissions (logs:CreateLogGroup, etc.)
- Pattern established for permission checking

**What works:**
- Role policies ARE evaluated when calls come through the API (via `authorize()`)
- CloudWatch Logs permissions ARE checked in `deliverLog()`
- Lambda has built-in policy checks for the Lambda service itself

**Gap:**
- When Lambda code runs in a subprocess and calls AWS APIs via boto3, those calls do NOT go through the same authorization layer
- They hit the proxy directly with the session credentials
- The session credentials are issued for the execution role, so they work, but there's no explicit "does this session have permission?" check at the proxy level for cross-service calls
- **This is acceptable for now** because SigV4 verification happens, but it's a gap

**To verify:** The policy engine in `src/app/api/policy/` determines if a call is allowed based on the session (principal), action, and resource.

## ❌ Step 4: Logging as network call
**Status: NOT YET IMPLEMENTED**

**Current implementation:**
```
Lambda code writes to stdout/stderr
  ↓
run.ts captures stdout/stderr as string
  ↓
Lambda handler calls deliverLog()
  ↓
deliverLog() checks permissions and writes to CloudWatch state
```

**What needs to change:**
```
Lambda code writes to stdout/stderr
  ↓
netshim.py captures writes, sends {'op': 'log_write', 'message': '...'} to runner
  ↓
run.ts receives log_write messages
  ↓
run.ts simulates logs.put_log_events() call through network model
  ↓
Network model decides: can Lambda reach CloudWatch? (route, security group, endpoint)
  ↓
If reachable: permission check and write to CloudWatch
  ↓
If not reachable: log dropped, reason in invocation record
```

**Files that need modification:**
1. `src/app/api/runtime/netshim.py` - capture stdout/stderr via intercept, send back to runner
2. `src/app/api/runtime/run.ts` - handle 'log_write' operations, simulate PutLogEvents call
3. `src/app/api/lambda/logging.ts` - accept network trace as input, merge with permission check

---

## Recommendation: What to do next?

You've completed steps 1 and 3 already. Step 2 (IAM enforcement) is 95% done but has the cross-service gap.

### Two options:

**Option 1: Just do Step 4 (Logging as Network Call)**
- ~5-7 days
- Makes logging go through the network model
- Shows realistic "Lambda in VPC without NAT can't reach CloudWatch" scenarios
- Leaves the cross-service permission gap (acceptable for now)

**Option 2: Quick gap-fill then Step 4**
- ~1-2 days to verify/tighten permission checks on cross-service calls
- ~5-7 days for logging as network call
- More complete, but the cross-service gap is already working (just not explicitly checked)

### My recommendation: 
Just do Step 4. The framework is ready, and you'll get the most value from "logging as a network call." The cross-service permission gap exists but is low-risk (SigV4 signatures verify the identity; the real permission check happens server-side).

---

## What Step 4 Gives You

Once logging becomes a network call:
- ✅ Variant A scenario: "Private subnet, no route" → Lambda can't reach CloudWatch either (log fails)
- ✅ Variant B scenario: "Private subnet with NAT" → Lambda logs work (goes through NAT)
- ✅ Variant C scenario: "Security group blocks egress" → Lambda can't log (blocked)
- ✅ Variant D scenario: "NAT deleted" → Lambda can't log (blackhole route)
- ✅ Logging now respects network boundaries, not just permissions

This is the final piece of the walking skeleton's promise: "Let the network model decide what happens."

---

## Implementation Plan for Step 4

See [logging-as-network-call-implementation.md](./logging-as-network-call-implementation.md) for detailed design.

Key insight: The shim is already set up to send messages back to the runner. We just need to add 'log_write' operations to the message stream.

