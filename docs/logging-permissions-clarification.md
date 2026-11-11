# Clarification: CloudWatch Logging Permissions

**Question:** Does the simulator check Lambda logging role permissions for CloudWatch access?

**Answer:** Yes, but with an important caveat about how it works today vs. how it should work.

## Current Implementation (Step 4, Walking Skeleton)

### What Happens

1. Lambda function code runs with stdout/stderr captured to a string buffer in `run.ts`.
2. When the function exits, the captured bytes are in `RunResult.log`.
3. The Lambda invocation handler calls `deliverLog()` in `logging.ts`.
4. `deliverLog()` checks permissions:
   ```typescript
   const wanted: [string, string][] = [
     ...(state.groups[group] ? [] : [['logs:CreateLogGroup', logGroupArn(scope, group)]]),
     ['logs:CreateLogStream', logStreamArn(scope, group, stream)],
     ['logs:PutLogEvents', logStreamArn(scope, group, stream)],
   ]
   for (const [action, resource] of wanted) {
     const denied = accessDenial(session, action, resource)
     if (denied) {
       return { Status: 'not-written', Reason: denied.message }
     }
   }
   ```
5. If any permission is denied, the log is **not written** to CloudWatch Logs.
6. The invocation record includes `LogDelivery` with the reason:
   ```json
   {
     "Group": "/aws/lambda/orders-fn",
     "Stream": "2026/11/10/[$LATEST]0341cc…",
     "Status": "not-written",
     "Reason": "User: arn:aws:iam::123456789012:user/lambda-executor is not authorized to perform: logs:PutLogEvents on resource: arn:aws:logs:eu-west-1:123456789012:log-group:/aws/lambda/orders-fn:log-stream:2026/11/10/[$LATEST]0341cc…"
   }
   ```

### What's Correct

- ✅ Permissions are enforced.
- ✅ Missing permissions are reported in the invocation record.
- ✅ A role without `logs:PutLogEvents` will not have its log written.
- ✅ The invocation record explains why.

### What's Not Ideal

- ❌ The log is captured **before** permissions are checked (in memory as subprocess output).
- ❌ The check happens **post-facto**, not as part of a network call.
- ❌ If the role has `logs:PutLogEvents`, the log is written directly; if not, it's discarded.
- ❌ The permission model treats logging like any other API call, but the Lambda runtime doesn't call boto3; it's automatic.

## Real AWS Behavior

In real AWS:
1. The Lambda runtime captures stdout/stderr.
2. It calls `logs.put_log_events()` with those bytes.
3. If the execution role doesn't have `logs:PutLogEvents`, the call fails.
4. The Lambda runtime handles the failure gracefully: it logs a warning to stderr (which won't be sent anywhere) and continues.
5. The function is **not told** the log delivery failed.
6. The caller of `Invoke` is **not told** either (unless they check CloudWatch or CloudTrail).

## Simulator Gap

The simulator is **missing the network call**. In a more complete model:

1. `run.ts` should NOT capture stdout/stderr directly.
2. Instead, the Python shim should intercept `sys.stdout.write()` and `sys.stderr.write()`.
3. The shim sends these back to `run.ts` with a message like `{'op': 'log_write', 'message': '...'}`.
4. `run.ts` simulates a `logs.put_log_events()` call:
   - Asks the network model: "Can I reach CloudWatch Logs?"
   - If denied (no route, security group blocks, no endpoint), the message is dropped and a note is made in the invocation record.
   - If allowed, the message is delivered to the simulated CloudWatch Logs service.
   - `deliverLog()` checks permissions and writes (or refuses to write) based on the execution role.
5. The invocation record includes the network trace AND the permission result.

## When to Fix

- **Not urgent for Phase 1:** The current approach is acceptable because:
  - Permissions are checked and enforced.
  - A role without `logs:CreateLogStream` will not have its log written.
  - The reason is reported in the invocation record.
  - The first scenario (Lambda in a VPC without NAT, calling STS) doesn't involve logging; it's about network connectivity.
  
- **Needed before:** Scenarios about "Lambda in a VPC cannot log because there's no NAT and no VPC endpoint" (future, Phase 2+).

- **Implementation order:** After the core Lambda scenario is complete, make logging a network call so it respects the network model.

## Workaround for Now

If you want to test permission denials for logging:
1. Create a Lambda role without `logs:PutLogEvents`.
2. Create and invoke a Lambda function with that role.
3. Check the invocation record's `LogDelivery` field.
4. It will show `Status: 'not-written'` and the reason.

Example:
```bash
# In the simulator
aws lambda create-function \
  --function-name test-no-logs \
  --role arn:aws:iam::123456789012:role/no-logs-role \
  --code S3Bucket=...,S3Key=...

aws lambda invoke \
  --function-name test-no-logs \
  /tmp/response.json

# In the invocation record (GET /api/lambda/inspect)
"LogDelivery": {
  "Group": "/aws/lambda/test-no-logs",
  "Stream": "2026/11/10/[$LATEST]abc123",
  "Status": "not-written",
  "Reason": "User: arn:aws:sts::123456789012:assumed-role/no-logs-role/test-no-logs is not authorized to perform: logs:PutLogEvents ..."
}
```

## Summary

| Aspect | Implemented? | Notes |
| --- | --- | --- |
| Check `logs:CreateLogGroup` permission | ✅ Yes | Only checked if the group doesn't exist |
| Check `logs:CreateLogStream` permission | ✅ Yes | Always checked |
| Check `logs:PutLogEvents` permission | ✅ Yes | Always checked |
| Report denied permissions in invocation record | ✅ Yes | `LogDelivery.Status` and `LogDelivery.Reason` |
| Model logging as a network call | ❌ No | Future; not needed for Phase 1 |
| Check network reachability to CloudWatch | ❌ No | Future; a VPC Lambda without NAT can still "log" today |
| Show CloudWatch calls in the network trace | ❌ No | Future; logs don't appear as connections in the trace |

The short version: **Yes, permissions are checked. No, it's not a network call yet.** This is acceptable for now and will be fixed when logging becomes a first-class network operation.
