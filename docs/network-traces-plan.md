# Plan: understandable traces and errors from the network simulation

Status: planned. It is part of the network layer in [architecture.md](./architecture.md#execution-contexts-and-the-emulated-network-design-not-started); this file says what the output of that layer has to look like. Nothing is implemented.

## Goal

When code under test runs in an execution context (Lambda in a VPC, an instance, outside AWS) and makes a call, the simulation has to say **where the call wanted to go, what happened at each step, and, when it did not work, which step failed and why**, in terms someone can act on without knowing how the simulator works. "Denied" or "timed out" is what the real world gives you; this app exists to explain it.

Two outputs, never mixed:
- **What the code under test sees.** The failure as the real client library would report it (a connect timeout for a security group drop, `Name or service not known` for a name that does not resolve, an `AccessDeniedException` from the API). The code under test must behave as it would in AWS.
- **The trace.** A side channel with the explanation. It is returned with the result of a run (for example the Lambda invoke result), written to a trace file, and retrievable by ID; the code under test cannot see or depend on it.

## The trace is the return value

Traces are produced by the pure network model (building block 1), not by logging added afterwards. Every function (resolve, route, filter, evaluate policy) returns `{ decision, trace }`, and a larger function concatenates the traces of the steps it ran. That makes traces testable as snapshots and keeps the explanation in step with the logic.

```
Trace    = { id, from, to, intent, outcome, steps[] }
from     = the execution context: "lambda fn-x in subnet-a (vpc-1), sg-1"
intent   = what the code asked: "HTTPS to sqs.eu-west-1.amazonaws.com:443 (SQS SendMessage)"
outcome  = reached | failed, and for a failure: the first failing step and its category
Step     = { phase, summary, decision (allow | deny | no-match | info), detail, evidence[], notEvaluated? }
```

`phase` is one of: `dns`, `route`, `endpoint`, `security-group-out`, `nacl-out`, `nacl-in`, `security-group-in`, `delivery`, `authentication` (SigV4, expiry), `authorization` (IAM, SCP, resource policy, endpoint policy), `service` (the API's own error).

`evidence` names the resources and rules that decided: route table, the matching route and why it won, the security group and the rule, the NACL and rule number, the policy statement. Ids, as the console shows them, plus the name tag when there is one.

## What a good step says

Each step answers four questions in plain language:
1. **What was asked** ("Which address does `sqs.eu-west-1.amazonaws.com` resolve to from subnet-a?").
2. **What was found** ("No interface endpoint with private DNS in vpc-1, so the public address 52.x.x.x").
3. **What it means for this call** ("The next hop has to be found for a public address").
4. **Why it was decided that way**, including what *else* was considered ("`rtb-9` (explicit association of subnet-a) has `10.0.0.0/16 -> local` and `0.0.0.0/0 -> nat-1`; `0.0.0.0/0` is the most specific match for 52.x.x.x; `nat-1` is in `subnet-p`, whose route table has no internet gateway route, so the packet has no way out").

For failures, add the **first failing step** (in packet order) and **every other problem found**: checks that do not depend on each other (security group, network ACL, route) are all evaluated, so one run shows all of them; only steps that depend on a failed one are marked **not evaluated** (marked as such, not omitted). Add a **cause category** that can be filtered on: `dns-resolver-disabled`, `no-route`, `blackhole-route`, `no-public-ip`, `security-group-blocks`, `nacl-blocks`, `nat-gateway-unavailable`, `nat-gateway-private`, `nat-without-internet-route` (built), and later `dns-no-record`, `dns-wrong-answer`, `no-endpoint`, `endpoint-policy-denies`, `iam-implicit-deny`, `iam-explicit-deny` (with the policy and statement), `scp-denies`, `resource-policy-denies`, `condition-key-missing`, `quota-exceeded`, ...

Example of the target text for a Lambda in a private subnet without NAT:

```
lambda orders-fn (vpc-0a1, subnet-0b2 [private], sg-0c3) -> sqs.eu-west-1.amazonaws.com:443   FAILED at routing
  1 dns       sqs.eu-west-1.amazonaws.com -> 52.94.x.x        no interface endpoint for sqs in vpc-0a1, so the public address is used
  2 route     52.94.x.x from subnet-0b2                       rtb-0d4 (main route table) has only 10.0.0.0/16 -> local; no route matches a public address
  3 security-group-out / nacl                                   allowed (they do not depend on the route)
  4 delivery                                                    not evaluated: there is no route
  Cause: no-route. To reach SQS from this subnet add a route 0.0.0.0/0 to a NAT gateway, or create an interface endpoint for sqs in vpc-0a1 (with private DNS).
  What the function sees: ConnectTimeoutError: Connect timeout on endpoint URL "https://sqs.eu-west-1.amazonaws.com/"
```

The "To reach..." line is a hint derived from the category, kept clearly separate from the facts above it, and it can be wrong; the facts cannot.

## Silent failures and real-world behaviour

Real networks do not tell you what happened: a security group or NACL drop is a timeout, a missing route is a timeout, a missing return path is a hang. The trace says what the real client would observe (`observed: timeout after connect`), and also whether the simulator **stops immediately** instead of really waiting (it should, with the trace stating the real behaviour and the real default timeout, so tests are fast and still honest).

## IAM and service errors

Authorization steps use the same format: which identity, which action and resource ARN, which context keys had which values (`aws:SourceVpce` = absent because the request came through the NAT, not an endpoint), the policies evaluated in order (SCP, RCP, permissions boundary, session policy, identity policy, resource policy, endpoint policy) and the one that decided, with "implicit deny: no statement allows it" and "explicit deny in statement X of policy Y" kept distinct. This is the same output the "can X do Y from Z" query of the policy engine returns, so one rendering serves both.

Cost note, from a spike of the shim ([walking-skeleton.md](./walking-skeleton.md)): the SDK retries a failed connection (botocore tried five times with backoff, 9 s for one failed call, and the network decision ran five times). The simulation runs the code with a **virtual clock**, so a failure is fast while the trace states what it would have cost in real time (attempts, connect timeout and backoff added up), and the trace **collapses the retries** into one entry ("5 attempts, same decision") instead of repeating it.

## Rendering and delivery

- **Data**: the structure above as JSON, stable and versioned, the source of truth.
- **Text**: the indented form for terminals, logs and test failures (`lambda.canReach(...)` raising an exception whose message is the rendered trace).
- **Later**: a UI view (hop by hop on a diagram of the VPC), a query endpoint (`GET /traces/<id>`), a header on emulated responses (`x-emulated-trace-id`) so a trace can be found from a response.
- Every trace has an ID, a timestamp, the context and the request ID(s) of the API calls involved, so the trace can be matched to the request in the server log and to the CloudTrail-like record later.

## Quality rules

- Wording is reviewed like an API: no internal jargon, no "the simulator failed to" for what is a modelled AWS outcome, resource IDs always shown, no step silently omitted.
- Snapshot tests for the canonical scenarios (the list in the architecture notes and the Lambda plan); a trace change shows up as a diff in review.
- Where the simulator does not model something (an unsupported service, a missing feature) the trace says **"not modelled"** with the name, instead of guessing allow or deny. A prediction that is unknown must be visible as unknown.

## Order

1. Define the `Trace` / `Step` types and the text renderer together with the first network-model function (DNS or route lookup).
2. Every later model function (routes, security groups, NACLs, endpoints) returns its steps from the start.
3. Authorization steps once the policy engine exists.
4. Surfacing: Lambda invoke result and the shim's exceptions, then the query endpoint and UI.

## Open questions

- Level of detail by default: the full trace is long; the default view may show only the failing step with its neighbours and expand on request.
- Which wording for the hint line, and whether hints should ever be machine-readable (a suggested change that could be applied and re-tested: "what if I add this route?").
- How traces are retained (per run, per account, size cap).
