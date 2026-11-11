# Logging Architecture: Decisions and Tradeoffs

## Current State

As of the walking skeleton (step 4), the simulator has a **minimal logging story** that correctly models the *what* but not the *how*:

- **What happens:** Lambda functions capture stdout/stderr and deliver them to CloudWatch Logs (via `logs:PutLogEvents`) with the permissions of the execution role. If the role lacks permissions, the log is silently not written.
- **How it's implemented currently:** 
  - `run.ts` collects stdout/stderr from the Python subprocess directly (lines 272-276).
  - The log is returned as a string in `RunResult.log`.
  - Lambda's `Invoke` handler calls `deliverLog()` in `logging.ts`, which checks role permissions and writes to the simulated CloudWatch Logs service.
  - The actual bytes never transit a "CloudWatch" component; they're captured in memory and written directly to the state machine.

## Three Questions

### 1. Do real Lambdas log via CloudWatch over NAT, or use a shortcut?

**Real AWS behavior:**
- Lambda functions run in the **AWS-managed network** (if not VPC-attached) or in a **customer VPC** (if VPC-attached).
- Log delivery to CloudWatch uses the **same network path as any other AWS API call**:
  - **Not VPC-attached:** Public endpoint, direct internet access.
  - **VPC-attached:** Either through NAT (public endpoint) or a VPC endpoint (private endpoint with private DNS).
- There is **no shortcut**: the shim must apply the network model to *every* connection, including the ones to CloudWatch.

**Current simulator gap:**
- Logs bypass the network entirely. They're written directly from `run.ts` to the state machine, so:
  - A VPC-attached Lambda can log even without a NAT or endpoint (should fail).
  - The decision trace never shows a CloudWatch Logs API call.
  - Permissions are checked post-facto by `deliverLog()`, not as part of the network model.

**Recommendation:** Make logging a first-class network call that goes through the shim. This means:
1. The Python Lambda code calls `boto3.logs.put_log_events()` (or the runtime does it automatically).
2. The shim intercepts the call like any other.
3. The network model decides if it's reachable (route, security group, NACLs, endpoints).
4. If reachable and authorized, the call succeeds; if not, it fails (or times out).

---

### 2. Is netshim.py the right approach, or should you host a DNS on a port in the Next.js app?

**Current netshim.py approach:**
- Intercepts socket connections and HTTP library calls at the Python level (http.client, urllib3).
- Asks the runner (over file descriptor 3) whether a connection is allowed.
- If allowed, creates a real TCP connection to `JPK_SIM_HOST:JPK_SIM_PORT` (localhost:3000).
- Keeps the original `Host` header so SigV4 signatures are valid.

**Pros:**
- ✅ Works for boto3 and any Python code using standard libraries.
- ✅ No process-wide state or globals needed (intercepted at the socket layer).
- ✅ Virtual clock is accurate (sleeps, retries, timeouts all count correctly).
- ✅ Simple to add to: just replace one more connect or one more library call.

**Cons:**
- ❌ Python-only (doesn't help with Node.js code run later).
- ❌ Fragile: relies on intercepting undocumented/private methods (`http.client.HTTPConnection.connect`).
- ❌ Hard to extend: if you add Rust, Java, Go contexts later, you need a separate shim per language.
- ❌ Does not model DNS resolution as a service (the network model never sees a DNS query).

**DNS-on-a-port approach:**
- Run a DNS server on `localhost:3001` (or another port in the Next.js app).
- Lambda code (and other runtimes) do normal DNS queries to `127.0.0.1:3001`.
- The DNS server inspects queries and responds with answers based on the database (endpoints, VPC private DNS, route 53 zones).
- The code then connects to the resolved address, which the shim (or equivalent runtime hook) allows or denies.

**Pros:**
- ✅ Language-agnostic: works for any code that does DNS resolution (Python, Node.js, Go, Java...).
- ✅ Models DNS as a real service: the trace shows DNS queries and their answers.
- ✅ Clean separation: DNS is its own layer in the network model.
- ✅ Matches AWS: real Lambda code uses normal DNS and the kernel talks to Route 53 IMDS.

**Cons:**
- ❌ More complex: need to run a DNS server and handle zone files or on-the-fly answers.
- ❌ Subprocess setup more complex: bind the DNS server to 127.0.0.1 and pass the resolver config to Python (e.g., `systemctl`-style or `/etc/resolv.conf` trick).
- ❌ Latency: real DNS queries (even to localhost) have measurable overhead; virtual clock must account for it.
- ❌ Not needed for phase 1 (Lambda in a VPC without endpoints): bare IP addresses and the public endpoint work fine without DNS.

**Recommendation:** 
- **Short term (now):** Keep netshim.py. It's sufficient for the first demo (Lambda → STS over NAT).
- **Medium term (before multi-language support):** Add a DNS server if you're going to run Node.js, Go, or Java contexts. At that point, unify the approach.
- **Phase 2 (endpoints, Route 53):** DNS becomes unavoidable. Migrate to it then.

---

### 3. Should you patch boto3 to use `endpoint_url=http://localhost:3000` like the control plane does?

**Current state:**
- Lambda code runs with normal boto3, no `endpoint_url` override.
- The shim intercepts connections at the socket layer and redirects them to localhost:3000.
- The request keeps the original `Host` header (e.g., `sts.eu-west-1.amazonaws.com`), so SigV4 signatures are valid.
- The proxy (`proxy.ts`) checks the signature and routes based on the service name in the `Host` header.

**Patching boto3 with `endpoint_url`:**
- Set `boto3.client('sts', endpoint_url='http://localhost:3000')` automatically.
- All boto3 clients would connect to localhost:3000.
- The Host header would become `localhost` (or `localhost:3000`), not the real service name.
- Signatures would be invalid because SigV4 signs the real service name.

**Why not patch boto3:**
- ❌ **Breaks SigV4 signing.** The control plane overrides `endpoint_url`, but it's not signed with SigV4 (it uses token auth or a custom header). Lambda code is signed.
- ❌ **Would require signature verification against the patched Host.** The proxy would have to know "this request is actually for STS" even though the Host is localhost.
- ❌ **Defeats the shim's purpose.** The shim exists to decide connectivity based on the network model, not to force a fixed endpoint.
- ❌ **Adds another configuration layer.** Users would need to understand why their code runs with a fake endpoint, breaking debugging and IDE intelligence.

**Why the shim's approach is correct:**
- ✅ **Unmodified boto3.** Real Lambda code runs unchanged.
- ✅ **Valid signatures.** The proxy verifies them as-is.
- ✅ **Network model decides.** If the network model says "unreachable," the shim raises a connect timeout, not a 400 Bad Request.
- ✅ **Extensible.** Works for boto3, requests, urllib, even raw sockets.
- ✅ **Traces are real.** The connection records show the real service name, not localhost.

**The control plane is different:**
- It's the *simulator itself*, not simulated code.
- It doesn't need to model network reachability; it owns the backend.
- Using `endpoint_url` is a shortcut because the proxy and the backend are the same process.

**Recommendation:** **Keep the shim approach.** Do not patch boto3. The shim is the right abstraction and needs to be applied to all runtimes, not just Python.

---

## What's Missing: The Logging Loop

The current architecture has a gap: **logging is not a network call**, so it doesn't respect the network model.

**Ideal flow (not yet built):**
1. Python Lambda code runs with unmodified boto3 and a logging handler (e.g., `logging.StreamHandler(sys.stdout)`).
2. Handler writes to stdout.
3. The Lambda runtime (in a real AWS implementation) would call `logs.put_log_events()` with those bytes.
4. In the simulator, `run.ts` should:
   - NOT capture stdout directly.
   - Instead, have the Python shim call back with `{'op': 'log', 'message': '...'}`.
   - Route that through the same network model as any other call (i.e., ask `decide()` if it can reach CloudWatch).
   - If reachable, tell the Python process "yes, write it"; if not, "no, you can't reach CloudWatch."
5. The Python process decides whether to retry, drop it, or buffer it (like real Lambda does).
6. The invocation record includes `LogDelivery` with the reason (if it was not written, why: no route? permission denied? no endpoint?).
7. The trace shows the PutLogEvents call just like any other call.

**Why this matters:**
- A VPC Lambda without NAT and without an endpoint **cannot** log to CloudWatch (should be modelled as a failure or a permission error).
- The demo "Lambda reaches STS via NAT" should also show "Lambda logs to CloudWatch via NAT."
- Future scenarios about "this Lambda cannot reach its CloudWatch Logs because..." become possible.

**When to implement:**
- After Step 4 (walking skeleton) is done.
- Before Step 5 (VPC endpoints): endpoints change how logging is routed and need to be modelled.
- This is the "Afterwards (same step 4, asked for after the first inspection)" item in [walking-skeleton.md](./walking-skeleton.md) line 54.

---

## Known Limitations of netshim.py

### DNS Resolution in User Code

**Limitation:** If Lambda code calls `socket.getaddrinfo()`, `socket.gethostbyname()`, or any DNS resolver directly, the shim cannot intercept it. The code will try to use the real system resolver, not the simulator's.

```python
# ❌ This will NOT be intercepted by netshim.py
import socket
ip = socket.gethostbyname('sts.eu-west-1.amazonaws.com')  # Uses real DNS
sock = socket.socket()
sock.connect((ip, 443))

# ✅ This WILL be intercepted by netshim.py
import boto3
client = boto3.client('sts')  # boto3 uses http.client, which netshim intercepts
response = client.get_caller_identity()  # OK
```

**Impact:** User code must not do manual DNS resolution. boto3, requests, urllib, and other libraries that use `http.client` or `urllib3` are safe.

**Documentation needed:** Add a **User Guide section** titled "Lambda Code Limitations" that says:
- Code must use boto3 and standard Python HTTP libraries (requests, urllib, urllib3).
- Code must NOT use low-level socket APIs for DNS resolution (e.g., `socket.getaddrinfo()`, `socket.gethostbyname()`).
- Reason: The simulator intercepts HTTP connections, not DNS queries.
- Future: A DNS server on localhost will lift this limitation.

---

## Logging and CloudWatch Permissions

**Current state (a gap):**
- `run.ts` captures stdout/stderr directly from the Python subprocess.
- It is returned in `RunResult.log`.
- After the Lambda function finishes, the invocation handler calls `deliverLog()` in `logging.ts`.
- `deliverLog()` checks the execution role's permissions against `logs:CreateLogGroup`, `logs:CreateLogStream`, and `logs:PutLogEvents`.
- If any permission is denied, the log is NOT written and `LogDelivery.Status` is set to `'not-written'` with the reason.

**What's actually happening:**
- ✅ Permission checks ARE performed.
- ✅ A role without `logs:CreateLogStream` will NOT have its log written.
- ✅ The invocation record includes the reason why.
- ❌ **But the log was already captured.** The stdout/stderr are in memory and returned to the caller, even if the role couldn't write to CloudWatch.
- ❌ **The check happens post-facto**, not as part of a network call.

**Why this is incomplete:**
- In real AWS, if the role has no `logs:PutLogEvents` permission, the `put_log_events()` call **fails over the network**. The Lambda runtime handles the failure gracefully (drops or retries; the function itself is not told).
- In the simulator, the log is captured (the subprocess doesn't know about permissions), then checked, then conditionally written. The subprocess never sees the failure.
- This matters if code does `boto3.logs.put_log_events()` itself. It would get a permission error, which is correct, but the Lambda runtime's own logging would have already succeeded (incorrectly).

**When to fix:**
- After logging becomes a network call (the "future" section above). Then `deliverLog()` should issue a `PutLogEvents` API call that the network model and permission system can evaluate like any other call.

---

## Future: DNS Server Implementation

**Trigger:** When you add other language runtimes (Node.js, Go, Java) or when you need to model VPC endpoints and private DNS.

**Design:**
- Run a DNS server on localhost:5553 (or a port in the Next.js app).
- Lambda subprocesses are configured to use it as the resolver (e.g., via `resolv.conf` or environment variables).
- The DNS server:
  - Answers queries based on the VPC's Route 53 private hosted zones (when built).
  - Answers VPC endpoint private DNS names.
  - Falls back to "NXDOMAIN" for unknown names (or routes to real DNS for non-AWS names, for user convenience).
  - Logs each query with the answer and the trace (reachable, unreachable, etc.).
- The network model's DNS step will be explicit: "resolved `sts.eu-west-1.amazonaws.com` to `198.51.100.5` via NAT".

**Tradeoff:** More complex setup and overhead (DNS queries cost virtual time), but it's the correct model and works for all languages.

---

## Future: CloudTrail (Light Version)

**Goal:** Track API calls for debugging and auditing, without implementing full CloudTrail.

**Design:**
- Each API call to the simulator adds an entry to a simple event log.
- Fields: `timestamp`, `principalArn`, `eventName`, `sourceIP`, `requestParameters`, `responseElements`, `errorCode`.
- Stored as JSONL in `data/<account>/cloudtrail-events.jsonl`.
- Searchable via a new endpoint: `POST /api/cloudtrail/lookup-events` with filters (principal, event name, time range, etc.).
- Shown in the history view alongside the invocation records and resource state changes.

**Why simple:**
- No need for trails, S3 buckets, or SNS subscriptions (the features that make CloudTrail complex).
- Just a log of "who did what when."
- Enough to answer "why did this role get denied?" and "what did this function call?"

**When to implement:**
- After the core Lambda scenario is done. It's a nice-to-have for debugging and showing the audit trail.

---

## Summary

| Question | Answer | Recommendation |
| --- | --- | --- |
| **Logging path (NAT or shortcut?)** | Real AWS uses NAT or endpoints like any other service. Currently bypassed. | Model logging as a network call. After Step 4. |
| **netshim.py vs. DNS server** | netshim.py is good for Python-only. DNS is needed for multi-language. | Keep netshim.py now; add DNS when you add other runtimes or need endpoints. |
| **Patch boto3 with endpoint_url?** | No. The shim redirects connections and keeps signatures valid. Patching breaks both. | Keep the shim approach. Do not patch boto3. |
| **DNS resolution limitation** | netshim.py cannot intercept socket-level DNS calls. | Document in user guide. Add DNS server later. |
| **CloudWatch permissions** | They ARE checked, but post-facto. The log is captured regardless. | Acceptable now; fix when logging becomes a network call. |

The shim is the correct abstraction. It's not perfect yet, but it's the right direction. **Document the DNS limitation now in the user guide so users don't try to use socket-level DNS.**
