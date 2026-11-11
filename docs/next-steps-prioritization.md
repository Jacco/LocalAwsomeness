# Next Steps: Logging as Network Call (Final Step)

## Status: WALKING SKELETON COMPLETE ✅

All steps of Option A are now done:

✅ Step 1: Move invocation records to data/
- Location: `db/<account>/<region>/data/lambda-invocations/<function>.json`
- Per-function JSONL storage, separate from lambda.json state

✅ Step 3: UpdateFunctionCode operation
- Location: `src/app/api/lambda/service.ts`
- Code directory replacement works

✅ Step 2: IAM enforcement on function calls
- Authorization framework in place, role policies evaluated
- SigV4 signature verification works
- Permission checks on logs:* operations implemented

✅ Step 4: Logging as Network Call (JUST COMPLETED)
- netshim.py intercepts stdout/stderr writes, buffers them, sends log_write message
- run.ts receives log_write, simulates logs.put_log_events() call through network model
- logging.ts checks network reachability BEFORE checking permissions
- Network decision recorded in invocation record

### What This Enables

The network model now decides whether Lambda can log:

**Implementation (now complete):**
1. ✅ Modified netshim.py to intercept stdout/stderr and send log_write messages
2. ✅ Modified run.ts to receive log_write and simulate PutLogEvents call through network model
3. ✅ Modified logging.ts to accept network decision and check network reachability BEFORE permissions
4. ✅ Modified invoke.ts to pass network decision to deliverLog()

---

## Next Steps: Beyond the Walking Skeleton

Now that the skeleton is complete, here are the high-value items for Phase 2 & 3:

### Phase 2: Completeness (1-2 weeks)

1. **CloudTrail comprehensive logging** (all API calls, not just control plane)
   - Track every call from users, Lambda code, EC2 user data
   - Single JSONL audit trail with queryable schema
   - Enables: post-mortems, debugging, compliance

2. **Logging from EC2 user data** (optional, enables validation)
   - EC2 instances can now write logs via simulated user data scripts
   - Enables: testing infrastructure code that reads/writes logs

3. **Test the full four-variant scenario end-to-end**
   - Create VPCs, subnets, Lambda with/without routes, with/without NAT
   - Verify logs appear/disappear based on network config
   - Verify network trace shows PutLogEvents call

### Phase 3: Advanced Features (2-4 weeks)

1. **DNS server** (needed for multi-language support)
   - Answer DNS queries based on Route 53 private hosted zones
   - Enables: Go, Java, Node.js code that does socket-level DNS
   - Enables: VPC endpoints with private DNS

2. **VPC endpoints with private DNS** (logs endpoint)
   - Lambda can reach logs service via VPC endpoint instead of NAT
   - Enables: testing access control on VPC endpoints

3. **Policy conditions on aws:SourceVpc, aws:SourceVpce**
   - Role policies can check where the call comes from
   - Enables: "allow logs from VPC endpoint but not NAT" patterns

4. **Log tail (LogType=Tail)** (optional, nice for testing)
   - Caller gets tail of log in response headers
   - Currently returns full log, should return last N lines

---

## Architecture is Solid

All core pieces are now in place:

✅ Network model with traces  
✅ Lambda execution in simulated context  
✅ Logging as first-class network call (checks network before permissions)  
✅ Invocation records with network decision  
✅ IAM role/policy evaluation  

The simulator now correctly models the core constraint: "Lambda must have both network access AND permissions to log."

