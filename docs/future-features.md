# Future Features: DNS Server and CloudTrail

This document tracks planned improvements to the simulator.

## DNS Server Implementation

**Status:** Planned (Phase 3 or later)

**Trigger:** 
- Adding multi-language runtime support (Node.js, Go, Java).
- Implementing VPC endpoints with private DNS.
- Supporting Route 53 private hosted zones.

**Problem it solves:**
- Currently, netshim.py only intercepts HTTP library calls. Socket-level DNS resolution (e.g., `socket.getaddrinfo()`, `socket.gethostbyname()`) cannot be intercepted.
- This limits code to Python libraries that use `http.client` or `urllib3` (boto3, requests, urllib).
- Other languages and low-level socket code won't work.

**Solution:**
1. Run a DNS server on localhost (e.g., port 5553).
2. Lambda subprocesses are configured to use it as the system resolver.
3. The DNS server answers:
   - VPC Route 53 private hosted zone queries (when implemented).
   - VPC endpoint private DNS names.
   - Public AWS service names (from reference data).
   - Falls back to `NXDOMAIN` for unknown names.
4. Each query is logged with the answer and why (e.g., "resolved via private DNS of endpoint vpc-123").

**Design notes:**
- The network model's trace will include explicit DNS steps.
- Works for all languages (Python, Node.js, Go, Java, etc.).
- Virtual clock must account for DNS query latency (minimal, but nonzero).
- Consider caching for performance.

**Estimated complexity:** Medium (10-20 days of work)

**Blocked by:** Nothing; can be implemented independently.

---

## CloudTrail (Light Version, Comprehensive)

**Status:** Planned (After core Lambda scenario is complete)

**Problem it solves:**
- Debugging: "What API calls did this Lambda make?"
- Auditing: "Who called what and when?"
- Understanding role denial reasons: "The role was denied here, and here's the proof in the audit log."
- Post-mortem analysis: "What sequence of events led to this state?"

**Scope: Comprehensive (All API Calls)**
- Every control plane call (user creates/deletes resources)
- Every data plane call (Lambda invokes, S3 gets object, etc.)
- Every API call from Lambda code (STS, EC2, CloudWatch, etc.)
- Every internal call (including logging to CloudWatch)
- One central audit trail, no filtering

**Solution:**
A simple append-only log of **all** API calls with searchable fields.

**Fields per event:**
- `eventId`: Unique ID (UUID)
- `timestamp`: ISO 8601 time
- `eventSource`: Service name (`lambda`, `ec2`, `sts`, `logs`, `s3`, etc.)
- `eventName`: API action (e.g., `CreateFunction`, `GetCallerIdentity`, `PutLogEvents`)
- `principalArn`: The caller (role, user, or service)
- `sourceIP`: IP address of the caller (from network context)
- `sourceContext`: Where the call came from (`user`, `lambda`, `ec2-user-data`, etc.)
- `requestParameters`: Sanitized input to the API (not sensitive values)
- `responseElements`: Key fields of the response (status, IDs created, etc.)
- `errorCode`: If the call failed (e.g., `UnauthorizedOperation`, `InvalidGroup.NotFound`)

**Storage:**
- File: `db/<account>/cloudtrail-events.jsonl`
- One JSON object per line, in chronological order.
- Append-only; never modify or delete individual events.

**Query endpoint:**
- `POST /api/cloudtrail/lookup-events`
- Filters: `principalArn`, `eventName`, `eventSource`, `startTime`, `endTime`, `errorCode`, `sourceContext`
- Returns: Matching events, paginated
- Searchable by: Principal, event name, service, time range, success/failure, source context

**UI integration:**
- History view shows events alongside invocation records and resource state changes.
- Can drill down to see what a function or role did.
- Can compare before/after API calls to understand state changes.
- Timeline view: "here's what happened in chronological order."

**Example query:**
```bash
POST /api/cloudtrail/lookup-events
{
  "principalArn": "arn:aws:sts::123456789012:assumed-role/orders-fn-role/orders-fn",
  "startTime": "2026-11-11T00:00:00Z",
  "endTime": "2026-11-11T23:59:59Z"
}
```

**Response:**
```json
{
  "events": [
    {
      "eventId": "12345678-1234-1234-1234-123456789012",
      "timestamp": "2026-11-11T07:04:50Z",
      "eventSource": "lambda",
      "eventName": "Invoke",
      "principalArn": "arn:aws:iam::123456789012:user/alice",
      "sourceIP": "203.0.113.1",
      "sourceContext": "user",
      "responseElements": { "functionArn": "arn:aws:lambda:eu-west-1:123456789012:function:orders-fn", "executionArn": "..." }
    },
    {
      "eventId": "87654321-4321-4321-4321-210987654321",
      "timestamp": "2026-11-11T07:04:51Z",
      "eventSource": "sts",
      "eventName": "GetCallerIdentity",
      "principalArn": "arn:aws:sts::123456789012:assumed-role/orders-fn-role/orders-fn",
      "sourceIP": "203.0.113.42",
      "sourceContext": "lambda",
      "responseElements": { "arn": "arn:aws:sts::123456789012:assumed-role/orders-fn-role/orders-fn", "accountId": "123456789012", "userId": "AIDAI..." }
    },
    {
      "eventId": "11223344-5566-7788-99aa-bbccddeeff00",
      "timestamp": "2026-11-11T07:04:52Z",
      "eventSource": "logs",
      "eventName": "PutLogEvents",
      "principalArn": "arn:aws:sts::123456789012:assumed-role/orders-fn-role/orders-fn",
      "sourceIP": "203.0.113.42",
      "sourceContext": "lambda",
      "errorCode": null,
      "responseElements": { "nextSequenceToken": "..." }
    },
    {
      "eventId": "aabbccdd-eeff-0011-2233-445566778899",
      "timestamp": "2026-11-11T07:04:53Z",
      "eventSource": "lambda",
      "eventName": "Invoke",
      "principalArn": "arn:aws:sts::123456789012:assumed-role/orders-fn-role/orders-fn",
      "sourceIP": "203.0.113.42",
      "sourceContext": "lambda",
      "responseElements": { "functionArn": "...", "statusCode": 200, "payload": "{...}" }
    }
  ]
}
```

**Why "comprehensive" instead of "light":**
- Single source of truth: everything in one log
- Better debugging: see the full chain of calls
- Better post-mortems: understand exactly what happened
- Not more work: you're capturing all calls anyway, just send them all to CloudTrail
- Not more storage: one JSONL file, append-only
- Query still simple: same endpoint, just more events to search

**Why this is better than "control plane only":**
- Control plane only: "The user created a function." (missing the Lambda's actual work)
- Comprehensive: "The user created a function. The Lambda invoked. The Lambda called STS. The Lambda logged. Everything in sequence."
- Debugging: "Why did the Lambda fail?" → See the exact sequence of API calls
- Auditing: "What did this role do?" → All its calls in one place

**Estimated complexity:** Low (5-10 days)
- Same as control plane only, just more events captured
- One JSONL file per account per region (or per account, location TBD)
- Query endpoint same
- No additional infrastructure

**Blocked by:** Nothing; can be implemented independently after core Lambda, or in parallel with other work.

---

## Priority

1. **DNS Server** - High priority if multi-language support is planned soon; medium if Python-only for now.
2. **CloudTrail** - Medium priority; useful for debugging and demos, but not essential for core functionality.

Both can be implemented in parallel or independently; they don't depend on each other or on other features.
