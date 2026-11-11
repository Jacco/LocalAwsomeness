# Implementation: Logging as a Network Call

## High-Level Flow

```
Lambda code: print("message")
  ↓
netshim.py intercepts sys.stdout.write()
  ↓
netshim sends {'op': 'log_write', 'message': '...'} to runner (fd 3)
  ↓
run.ts receives and buffers log messages
  ↓
When Lambda exits, run.ts simulates logs.put_log_events() call
  ↓
Network model evaluates: can this Lambda reach CloudWatch Logs?
  ↓
If yes: permission check + write to CloudWatch state
If no: log dropped, reason recorded in invocation record
  ↓
Invocation record includes LogDelivery with both network result AND permission result
```

## Implementation Steps

### Step 1: Modify netshim.py to Capture and Send Log Messages

**File:** `src/app/api/runtime/netshim.py`

**Current behavior:**
- `sys.stdout.flush()` and `sys.stderr.flush()` just flush the file descriptors
- All stdout/stderr goes directly to the subprocess's stdout/stderr
- The runner captures it in `run.ts`

**New behavior:**
- Intercept `sys.stdout.write()` and `sys.stderr.write()`
- Buffer the messages
- Periodically send back to runner with `{'op': 'log_write', 'messages': [...]}`
- Still let the subprocess capture it (for debugging if logs fail)

**Changes:**
```python
_original_stdout_write = sys.stdout.write
_original_stderr_write = sys.stderr.write
_log_buffer = []

def _log_write(message):
    """Send log message back to runner."""
    _log_buffer.append(message)
    if len(_log_buffer) >= 100 or '\n' in message:  # batch or on newline
        _send({'op': 'log_write', 'messages': _log_buffer})
        _log_buffer = []

def _stdout_write(message):
    _log_write(message)
    return _original_stdout_write(message)  # keep going to stdout for direct capture

def _stderr_write(message):
    _log_write(message)
    return _original_stderr_write(message)  # keep going to stderr

# In install():
sys.stdout.write = _stdout_write
sys.stderr.write = _stderr_write
```

**Why keep the original output?**
- Easier debugging if something goes wrong with network delivery
- User can still see the log in real time
- Run.ts has both channels: direct capture AND messages from shim

### Step 2: Modify run.ts to Handle Log Messages and Simulate PutLogEvents

**File:** `src/app/api/runtime/run.ts`

**Current state:**
```typescript
let log = ''
child.stdout!.on('data', chunk => {
  log = (log + chunk).slice(0, MAX_OUTPUT)
})
```

**New state:**
```typescript
let logMessages: string[] = []  // messages from shim

const handle = (message: { op: string; ... }) => {
  // ... existing cases ...
  if (message.op === 'log_write') {
    logMessages.push(...message.messages)  // collect messages
  }
}

// After child process exits:
// Simulate logs.put_log_events() call
if (logMessages.length > 0) {
  const logDecision = decide(
    scope, 
    source, 
    'logs.us-east-1.amazonaws.com', 
    443, 
    'https'
  )
  // Record this connection
  if (logDecision.verdict === 'allow') {
    // Log is reachable, permission check will happen in deliverLog
    log = logMessages.join('')
  } else {
    // Log not reachable
    log = ''
    // Record why in invocation record later
    const reason = logDecision.message
  }
}
```

**Key points:**
- Use the existing `decide()` function to check if CloudWatch Logs is reachable
- If unreachable, don't deliver the log (just like AWS)
- Pass the network decision to the invocation handler

### Step 3: Modify Lambda Invoke Handler to Use Network Decision

**File:** `src/app/api/lambda/invoke.ts`

**Current code:**
```typescript
const outcome = { ... }
const logDelivery = deliverLog(
  scope, 
  name, 
  credentials.session, 
  logStream, 
  run.log.split('\n').filter(l => l), 
  started, 
  run.exitCode === 0 ? run.realSeconds * 1000 : ...
)
```

**New code:**
```typescript
// Pass network decision to deliverLog
const logDelivery = deliverLog(
  scope,
  name,
  credentials.session,
  logStream,
  run.log.split('\n').filter(l => l),
  started,
  run.exitCode === 0 ? run.realSeconds * 1000 : ...,
  run.logNetworkDecision  // new parameter
)
```

**Modify logging.ts:**
```typescript
export function deliverLog(
  scope: Scope, 
  functionName: string, 
  session: string, 
  stream: string, 
  lines: string[], 
  start: number, 
  durationMs: number,
  networkDecision?: Decision  // new parameter
): LogDelivery {
  const group = logGroupName(functionName)
  const state = loadLogs(scope)
  const delivery = { Group: group, Stream: stream }
  
  // Check network first
  if (networkDecision && networkDecision.verdict !== 'allow') {
    return { 
      ...delivery, 
      Status: 'not-written', 
      Reason: networkDecision.message,
      NetworkTrace: networkDecision.trace  // optional: include trace
    }
  }
  
  // Then check permissions (existing logic)
  const wanted: [string, string][] = [
    ...(state.groups[group] ? [] : [['logs:CreateLogGroup', logGroupArn(scope, group)]]),
    ['logs:CreateLogStream', logStreamArn(scope, group, stream)],
    ['logs:PutLogEvents', logStreamArn(scope, group, stream)],
  ]
  for (const [action, resource] of wanted) {
    const denied = accessDenial(session, action, resource)
    if (denied) {
      return { ...delivery, Status: 'not-written', Reason: denied.message }
    }
  }
  
  // Write log if both network and permissions allow
  const g = state.groups[group] ?? createGroup(state, group, {}, start)
  const s = createStream(g, stream, start)
  const end = start + Math.ceil(durationMs)
  appendEvents(scope, g, s, lines.map(message => ({ timestamp: timestampOf(message, start, end), message })), Date.now())
  saveLogs(scope, state)
  return { ...delivery, Status: 'written' }
}
```

### Step 4: Update Invocation Record

**File:** `src/app/api/db/lambda.ts`

**Update InvocationRecord:**
```typescript
export interface InvocationRecord {
  // ... existing fields ...
  LogDelivery: {
    Group: string
    Stream: string
    Status: 'written' | 'not-written'
    Reason?: string
    NetworkTrace?: Trace  // new: show why network blocked it
  }
}
```

This allows debugging: if a log wasn't written, check LogDelivery to see if it was network (no route, security group) or permissions (no logs:PutLogEvents).

### Step 5: Update Tests

**File:** `src/app/api/__tests__/lambda.test.ts`

Add tests for:
1. "Log with NAT (variant B)" - log works
2. "Log without route (variant A)" - log fails, trace shows no-route
3. "Log without security group egress (variant C)" - log fails, trace shows sg-blocks
4. "Log with role missing permission" - log fails, reason shows permission denied

Example test:
```typescript
it('logs work when route exists (variant B)', async () => {
  // Setup: private subnet with NAT route
  const invocation = await invoke(...)
  expect(invocation.LogDelivery.Status).toBe('written')
})

it('logs fail when route does not exist (variant A)', async () => {
  // Setup: private subnet with only local route
  const invocation = await invoke(...)
  expect(invocation.LogDelivery.Status).toBe('not-written')
  expect(invocation.LogDelivery.Reason).toContain('no-route')
})

it('logs fail when role has no permission', async () => {
  // Setup: role without logs:PutLogEvents
  const invocation = await invoke(...)
  expect(invocation.LogDelivery.Status).toBe('not-written')
  expect(invocation.LogDelivery.Reason).toContain('UnauthorizedOperation')
})
```

---

## Implementation Checklist

- [ ] Modify netshim.py to intercept stdout/stderr and send log_write messages
- [ ] Modify run.ts to receive log_write messages and simulate PutLogEvents call
- [ ] Modify lambda/invoke.ts to pass network decision to deliverLog
- [ ] Modify logging.ts deliverLog() to accept and use network decision
- [ ] Update InvocationRecord type to include NetworkTrace in LogDelivery
- [ ] Add tests for all four variants (A, B, C, D) with logging
- [ ] Add test for permission denied case
- [ ] Verify existing tests still pass
- [ ] Update docs: walking-skeleton.md with new step completed

---

## Key Insight

The existing infrastructure is already built for this:
- `decide()` function exists and evaluates network reachability ✓
- Message protocol between shim and runner exists ✓
- Invocation record storage exists ✓
- Permission checking framework exists ✓

You're just connecting these pieces together for logging.

---

## Estimated Time

- netshim.py changes: 1-2 days
- run.ts changes: 1-2 days
- invoke.ts + logging.ts changes: 1 day
- Tests: 2-3 days
- Debugging and fixes: 1-2 days

**Total: 5-7 days, as estimated**

---

## What This Enables

After this is done:
- ✅ Walking skeleton is truly complete (all four variants now include logging)
- ✅ Logging respects network boundaries (the key insight)
- ✅ Next step: VPC endpoints with private DNS (variant E)
- ✅ Next: Policy conditions on `aws:SourceVpc`, `aws:SourceVpce` (variant F)

