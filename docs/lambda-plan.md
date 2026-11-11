# Plan: Lambda as the first execution context

Status: **built (steps 1 to 4)**; the policy engine or VPC endpoints are the decision that follows (see "Order of work"). This plan was written before the work and is kept for the reasoning; what exists is described in [walking-skeleton.md](./walking-skeleton.md) ("Step 4 as built") and the Lambda reference [lambda.md](../src/app/api/lambda/lambda.md). Parts of the steps below that are still open: updates and versions of functions, the run token and request context on requests, IMDS and container credentials, the EC2 instance context.

**For users:** See [lambda-user-guide.md](./lambda-user-guide.md) for guidance on writing Lambda code for the simulator, including known limitations (e.g., socket-level DNS resolution) and the environment variables available. See [logging-architecture-decision.md](./logging-architecture-decision.md) for technical details on how logging and the network model work together.

This is the first concrete use of the design in [architecture.md](./architecture.md#execution-contexts-and-the-emulated-network-design-not-started): run code *as if* it were somewhere and let the emulated network and IAM decide what happens.

## Why Lambda first

- No OS, user data, AMI, instance lifecycle or SSH to emulate: a function is a handler plus configuration, and its environment is a handful of environment variables.
- Credentials are simple. Lambda does not use IMDS: the runtime hands the function the execution role's temporary credentials as environment variables.
- It covers both interesting network positions with the same code: not VPC-attached (AWS-managed network, internet access, no route into customer VPCs) and VPC-attached (ENIs in the configured subnets, security groups, internet only through NAT).
- It maps directly onto the README goals (`lambda.canReach(...)`, `lambda.canPerform(...)`) and the canonical test case in the architecture notes: *Lambda in a VPC without NAT reaching an AWS API*.

## Decisions taken

- **No Docker.** Function code runs as a Python subprocess (or in-process worker) started by the simulator, with the Lambda environment variables set and the faked network library in place of the real HTTP stack. Real Lambda runtime images are not used.
- **No real network binding.** `169.254.169.254` is never listened on. The shim intercepts it (and any other name or IP) before a socket is opened; the network model decides what it resolves to and whether it is reachable.
- **Python first**, as in the architecture notes. The network model stays language independent; only the shim is Python.
- **EC2 instance and IMDS come later.** They reuse the same network model, request context and credential machinery, and add `RunInstances`, instance profiles, IMDSv2 tokens and hop limit. Lambda needs none of that.

Facts about Lambda below are written from memory of AWS behaviour and must be checked against the Lambda documentation or a real account before they are relied on (same rule as "Not verified against real AWS" in `src/app/api/ec2/ec2.md`).

## What the function environment looks like

The runtime sets, among others: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (temporary credentials of the execution role), `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_LAMBDA_FUNCTION_NAME`, `AWS_LAMBDA_FUNCTION_VERSION`, `AWS_LAMBDA_FUNCTION_MEMORY_SIZE`, `AWS_LAMBDA_LOG_GROUP_NAME`, `AWS_LAMBDA_LOG_STREAM_NAME`, `AWS_EXECUTION_ENV`, `LAMBDA_TASK_ROOT`, `_HANDLER`, plus the function's own environment variables. The caller identity of those credentials is `arn:aws:sts::<account>:assumed-role/<role-name>/<function-name>`.

In the simulator the credentials are issued with the existing `sts:AssumeRole` machinery (`issueSession`) for the execution role, with the function name as session name, so they are verified by `proxy.ts` like any other session. Their lifetime and refresh behaviour is an open question (real Lambda rotates them while the environment lives).

## Where the code runs from the network's point of view

| | Not VPC-attached | VPC-attached |
| --- | --- | --- |
| Position | AWS-managed network, not in any customer VPC | An ENI per configured subnet/security-group combination, in the customer subnets, **shared by all functions with the same combination** (requester-managed, created by Lambda) |
| Internet | Yes, directly | Only via a NAT gateway in a public subnet (a public IP is never assigned; an IGW route alone does not work) |
| AWS APIs | Public endpoints | Public endpoint through NAT, or an interface endpoint (private DNS) or gateway endpoint |
| Route table used | none of the customer's | the route table of the subnet the ENI is in (explicit association, else the main one) |
| Filtering | none | security groups of the function, network ACL of the subnet |
| Context keys on requests to AWS | `aws:SourceIp` is a Lambda/AWS public address | via NAT: `aws:SourceIp` is the NAT's Elastic IP; via a VPC endpoint: `aws:SourceVpc`, `aws:SourceVpce`, `aws:VpcSourceIp` and **no** `aws:SourceIp` |

The ENI is a real resource in `ec2.json`: it shows up in `DescribeNetworkInterfaces` (requester-managed, description starting `AWS Lambda VPC ENI`), blocks `DeleteSubnet` and `DeleteVpc` (the existing checks already look at `state.networkInterfaces`) and its security groups cannot be deleted while it exists. Real AWS keeps the ENIs for a while after the function is deleted or its VPC config removed; whether to model that delay is an open question.

### Interfaces are shared between functions

Functions do **not** get an interface each. An interface belongs to a *combination* of one subnet and one set of security groups, and every function (and version) in the account with the same combination uses the same interface. The model:
- The shared interface is keyed by `(subnet id, sorted set of security group ids)`. Creating a function with a `VpcConfig` looks the combination up per configured subnet: if the interface exists it is reused and gains a reference; if not, it is created (in that subnet, with those groups, requester-managed, tagged with the function that caused it in its description).
- The interface carries the set of functions that use it (or a reference count). Deleting a function, or changing its subnets or security groups, drops its reference; the interface is deleted when the last reference goes (subject to AWS's release delay, see below). Two functions with the same subnet but different security groups use different interfaces.
- One IP address per interface, not per function: this is the reason the subnet does not run out of addresses quickly, and the simulation has to show the same behaviour. `AvailableIpAddressCount` of the subnet is derived from the interfaces in it (it is a fixed number today, set when the subnet is created; see the [quota plan](./quotas-plan.md)), and creating an interface in a full subnet fails with `InsufficientFreeAddressesInSubnet`; for Lambda that surfaces as a function state `Failed` with the `EC2 ... InsufficientFreeAddresses` reason code, which is the quota-style problem this app should predict.
- The interface a function's network position is derived from is therefore the shared one (the trace names it and lists which functions share it): several functions in the same subnet and security groups are the same source for routing and filtering. Security group rules that reference the functions' group apply to all of them.
- Real Lambda may use more than one interface for a combination when concurrency grows and takes time to become usable; start with exactly one per combination and say so in the traces ("modelled as one interface"). Verify the real behaviour and the number of addresses it consumes before relying on any address count.

## Prerequisites from EC2 (in this order)

1. Phase 2 (internet gateways, route tables): done and verified against the dev server.
2. Phase 3: security group and network ACL create/modify/delete and rule operations: done and verified against the dev server (`scripts/verify-ec2/`).
3. Phase 4: network interfaces (create/delete/attach, requester-managed flag), Elastic IPs, NAT gateways. Security groups already refuse deletion while an interface lists them in `Groups`.
4. Later, for the private-API demos: VPC endpoints (interface with private DNS, gateway) and Route 53 private hosted zones. The first demo (VPC Lambda, no NAT, call fails; with NAT, call works) does not need them.

## Steps

1. **Lambda API** (`src/app/api/lambda/`, a new service on the registry). REST JSON protocol with path parameters, so check whether `RestJsonProtocol` (used by `account`, one route file per operation) can route `/2015-03-31/functions/{name}/...` or needs to be extended. Operations: `CreateFunction` (inline `ZipFile` only; `S3Bucket` is not possible until S3 exists), `GetFunction`, `GetFunctionConfiguration`, `ListFunctions`, `UpdateFunctionConfiguration`, `UpdateFunctionCode`, `DeleteFunction`, tags, `Invoke` (RequestResponse). Versions, aliases, layers, event source mappings, URLs and concurrency later. State in `db/<account>/<region>/lambda.json` through `store.ts`. Validate the execution role against IAM state (`iam:PassRole` is part of the policy engine later). Generate the request/response shapes from the botocore Lambda model, the same way as EC2 (`getec2model.py`); reuse what that script and `request.ts` / `describe.ts` already do instead of writing a second mechanism.
2. **Lifetime** (see "Resource lifetime" in `ec2.md`). `VpcConfig` finds or creates the **shared** interface for each (subnet, security group set) combination (see "Interfaces are shared between functions"); deleting the function or changing its VPC config drops its reference and removes the interface with the last one; subnet, security group and VPC deletes respect them; creating a function in a VPC checks that subnets and security groups exist, belong to the same VPC and that the subnets are in different or same AZs as AWS allows. Role deletion while a function uses it is allowed in AWS, so do not block it.
3. **Network model as pure functions** (architecture building block 1) over the EC2 state: DNS resolution from a position, route lookup, security group and NACL evaluation, hop-by-hop trace. Unit tests with hand-built state, no sockets.
4. **Execution context** (building block 3): a `lambda` context derived from function state: identity (execution role session), environment variables, network position (none, or the ENI -> subnet -> route table chain).
5. **Request context**: define the context object, set it in the network layer, strip incoming context headers in `proxy.ts` (the same trust model as `x-aws-principal`), pass it into `authorize()`. First consumers: `aws:SourceIp`, `aws:SourceVpc`, `aws:SourceVpce`, `aws:SourceArn` and `aws:SourceAccount` once there is a policy engine to read them.
6. **Faked network library** (building block 4): a Python shim that replaces the HTTP layer boto3 uses, asks the network model for DNS, route and filtering decisions, attaches the request context and delivers to this server. It also answers `169.254.169.254` and `169.254.170.2` (container credentials) names itself, so the same shim serves the EC2 and container contexts later.
7. **Invoke**: the simulator starts the handler (`module.function`) in a Python subprocess with the shim and the environment above, passes the event, returns the payload, `X-Amz-Function-Error` and logs (`LogResult` with `LogType=Tail`), and enforces `Timeout`. The result of an invoke includes the decision trace of every call the function made, not only the return value; the trace format and wording rules are in [network-traces-plan.md](./network-traces-plan.md).
8. **Demo / acceptance scenarios**, each run against the simulator and, where possible, against a real account to compare:
   - VPC Lambda in a private subnet without NAT calls `sts:GetCallerIdentity`: fails at routing or DNS, and the trace says which.
   - Same function with a NAT gateway route: works, source IP is the NAT's Elastic IP.
   - Same function plus a bucket or role policy that requires `aws:SourceVpc`: denied via NAT, allowed via an interface/gateway endpoint (needs VPC endpoints and the policy engine).
   - Non-VPC Lambda: reaches the internet, cannot reach a private IP in a customer VPC.
   - Security group on the function blocks egress: the trace names the group and rule.

## Open questions

- Credential refresh: do the issued session credentials need to rotate during a long-lived environment, or is one session per invoke enough?
- Sandboxing the Python subprocess: the shim is cooperative (it replaces the HTTP stack), so code that opens raw sockets or uses another HTTP client bypasses it unless the shim also patches at the `socket` / `getaddrinfo` level (option 3 in the architecture notes).
- Deployment package format and runtimes: Python only at first; handler files come from the `ZipFile` in `CreateFunction`.
- ENI release delay after function deletion: model or ignore.
- How a scenario names the context (`lambda.canReach(...)` API, scenario file, or an environment variable naming the function), shared with the EC2 context.
