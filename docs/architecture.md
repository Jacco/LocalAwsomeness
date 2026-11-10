# Architecture notes

A local simulator of the AWS control plane. The AWS CLI and SDKs talk to this server; all state is JSON on disk. The goal is to answer questions about authorization and connectivity for a whole organization without touching a real account: **predict what real AWS would do for a given piece of code running in a given place**, without cloud infrastructure. The API emulation (this file's other sections) is the foundation; the part that makes it a predictor is the [emulated network and execution contexts](#execution-contexts-and-the-emulated-network-design-not-started).

## Request flow

```
aws cli --endpoint_url http://localhost:3000
  -> src/proxy.ts                 verify SigV4, resolve credentials, set x-aws-principal / x-aws-userid, rewrite URL
  -> src/app/api/<service>/       thin route file: `export const POST = <service>.post` (or postAction / postDynamic)
  -> src/app/api/registry.ts      decode (protocol adapter) -> authorize -> handler -> encode
  -> src/app/api/<service>/service.ts   operations: action -> handler, one defineService() per service
  -> src/app/api/db/<service>.ts  domain logic; all persistence goes through src/app/api/db/store.ts
```

- `proxy.ts` (Next 16 proxy, no matcher, so it also sees UI requests) re-signs the request with the stored secret and compares signatures. Unknown key, bad token, expired session and bad signature return AWS-shaped 403s (JSON or XML depending on content type). Incoming `x-aws-principal` / `x-aws-userid` headers are always stripped.
- Routing is derived from the credential scope (`service`). JSON services (`x-amz-target`) are rewritten to `/api/<service>/<TargetPrefix>/<Action>`; query and REST services to `/api/<service><path>`.

## Services and protocol adapters

A service is `defineService({ iamPrefix, protocol, operations })` in `src/app/api/<service>/service.ts`. Handlers receive `{ principal, account, region, userId, params }` (`RequestContext` in `registry.ts`); `params` is a `QueryParams` for query services and the parsed JSON body otherwise. They return the result object (or nothing) and throw `AwsError` on failure; the adapter does all encoding.

| Style | Services | Adapter (`src/app/api/protocols.ts`) | Request |
| --- | --- | --- | --- |
| Query / XML | iam, sts | `QueryProtocol(namespace, apiVersion)` | form body with `Action=` (`query.ts` has `QueryParams` and the XML builders) |
| JSON 1.0/1.1 | organizations, ssm, servicequotas | `JsonProtocol(version, invalidBodyType)` | JSON body, action from `x-amz-target` or the `[action]` route segment |
| REST JSON | account | `RestJsonProtocol` | one route file per operation (`<service>.postAction('Name')`) |
| EC2 query | ec2 | `Ec2Protocol` (`src/app/api/ec2/protocol.ts`) | form body with `Action=`, XML out with `<item>` lists, lowercase `requestId`, `<Response><Errors>` errors; names and shapes generated from the botocore model (see EC2 below) |

An operation is either a handler function or `{ handler, action?, resources? }`. `action` overrides the IAM action name (default `<iamPrefix>:<Operation>`) and `resources` returns the ARNs the operation touches (default `['*']`). SSM, STS `AssumeRole` and account declare resources; the other services still use `*`.

Errors: throw `AwsError(type, message, status)`. Unexpected non-`AwsError` exceptions become a 500 (`ServiceException` / `InternalFailure` / `InternalServerException` depending on protocol).

## State layout (`db/`)

| Path | Contents |
| --- | --- |
| `tokens.json` | Bootstrap keys: `{ keyId: { secret, role } }`. The default CLI key maps to management account `123456789012`. |
| `<account>/credentials.json` | Session keys issued by `sts:AssumeRole` (`ASIA...`, with session token and expiry). |
| `accounts.json` | Account registry (id, name, email). |
| `<mgmt-account>/organization.json` | Whole organization: OUs, members, SCPs, attachments, create-account requests. |
| `<account>/iam.json` | IAM roles with trust policy, inline and attached policies. |
| `<account>/account.json` | Contact info, alternate contacts, opted-in regions. |
| `<account>/<region>/ssm.json` | SSM parameters and service settings. |
| `<account>/<region>/ec2.json` | EC2 networking state for one region (VPCs, subnets, route tables, network ACLs, security groups and rules, internet gateways, DHCP options, network interfaces). Created with the region's default VPC on first use. |
| `<account>/quotas.json` | Quota overrides of the account: only the values that differ from the defaults in `data/aws/quotas.json`, per region for quotas that are per Region (`src/app/api/quotas.ts`). |

Every API call that changes state is persisted here through `src/app/api/db/store.ts`, with policy documents stored as real JSON (stringified only in API responses). Files are read and written whole and synchronously, with no locking; writes are atomic (temp file + rename). `db/` is derived state: `scripts/seed.sh` should be able to rebuild it, so after a storage format change the clean migration is to delete the seeded accounts and re-seed. Note `seed.sh` re-puts SSM parameters, so each run bumps their `Version` and `LastModifiedDate`.

## Reference data (`data/aws/`)

Read-only data AWS itself provides, shipped with the repo and never written by API calls (so it survives a `db/` reset). Loaded and cached by `src/app/api/db/reference.ts`.

| File | Contents |
| --- | --- |
| `managed-policies.json` | AWS-managed IAM policies (default version document, versions list, id, description), keyed by the ARN part after `policy/` (`ReadOnlyAccess`, `service-role/<name>`). Regenerate with `getpolicies.py` (needs real AWS credentials). Only the default version's document is stored. |
| `organizations-policies.json` | The built-in `FullAWSAccess` SCP and `RCPFullAWSAccess` RCP that AWS attaches automatically when the type is enabled. |
| `ec2-model.json` | The EC2 operations and shapes the simulator implements, trimmed from the botocore service model (Apache-2.0). Drives request decoding and response XML. Regenerate with `python3 getec2model.py` after adding operations to its `OPERATIONS` list. |
| `regions.json` | Regions with their availability zones, zone-id prefix and DHCP domain name (an approximation of what a typical account sees). |
| `quotas.json` | Default quotas and hard limits (Service Quotas code, default, maximum, adjustable, documentation source and the date it was checked), keyed by the symbolic key the code uses. Read through `quota()` / `hardLimit()` in `src/app/api/quotas.ts`, never directly. |

The IAM API serves these locally (`GetPolicy`, `GetPolicyVersion`, `ListPolicies`). Other AWS-provided data still hardcoded in code and candidates to move here: region lists (`db/common.ts`), SSM service-setting defaults (`db/ssm.ts`).

## Accounts and identity

- Member accounts are entered the way real AWS does it: `CreateAccount` creates `OrganizationAccountAccessRole` (trusting the management account root, `AdministratorAccess` attached); the caller uses `sts:AssumeRole` or a CLI profile with `role_arn` + `source_profile`.
- `AssumeRole` checks the role's trust policy (`Principal.AWS` only, conditions ignored) and issues a session credential stored in the target account.
- `x-aws-principal` is the caller ARN (`arn:aws:sts::<acct>:assumed-role/<role>/<session>` for sessions). The account of a request is the 5th `:` field of that ARN (`getRequestInfo`).

## Execution contexts and the emulated network (design, not started)

This is one of the main reasons the project exists. Today a request carries only what SigV4 proves: who signed it. Real AWS decides allow/deny on much more: *where the call came from* (which VPC, through which endpoint, from which IP, via which service) and whether the call could reach the API at all (DNS, routes, security groups). The idea is to run code *as if it were somewhere* and let the emulated network and IAM rules decide what happens.

### Concept

Code under test runs in an **execution context** (a vantage point) and does its I/O through a **faked network library**, a drop-in replacement for the stack it would normally use (for Python: `urllib`/`urllib3`/`requests`, and the HTTP layer boto3 uses). The library does not open real sockets to the outside world. It asks the emulated network what would happen and only then delivers the request, enriched with facts about where it came from, to this server (or to an emulated service endpoint).

```
code under test (python, ...)                 execution context: "lambda fn-x in vpc-1/subnet-a", "ec2 i-123",
  -> faked network lib (urllib/requests/boto)   "outside, ip 203.0.113.7", "service principal s3.amazonaws.com", ...
      1. DNS        what does the name resolve to from here?
      2. routing    can a packet get there and back? (route tables, IGW/NAT/endpoints/peering/TGW)
      3. filtering  security groups (stateful, both ends) and network ACLs (stateless, both directions)
      4. delivery   the request reaches the emulated API / service endpoint
      5. context    the network layer attaches request context (see below)
  -> src/proxy.ts -> registry -> authorize({ principal, action, resources, context }) -> handler
```

Every step can fail on its own (name does not resolve, no route, SG blocks, `AccessDenied` because `aws:SourceVpc` does not match) and the result should say *which* step and *why*, not just allow/deny. A decision trace is the product: "resolved `sqs.eu-west-1.amazonaws.com` to the public IPs (no interface endpoint with private DNS); route `0.0.0.0/0` -> `nat-...` in `rtb-...`; SG and NACL allow; denied by bucket policy: `aws:SourceVpce` not in `[vpce-...]`". Format, wording rules and failure categories: [network-traces-plan.md](./network-traces-plan.md).

### Execution contexts

An execution context says what identity code has and what network position it occupies. Examples, each with its own rules:

| Context | Network position | Identity and credentials |
| --- | --- | --- |
| Outside AWS (laptop, CI, on-prem) | internet source IP, or VPN/Direct Connect attachment | explicit access keys / assumed role |
| EC2 instance | primary ENI: subnet, private IP, security groups, optional public IP | instance profile role via IMDS (`169.254.169.254`, IMDSv2 tokens, hop limit) |
| Lambda, not VPC-attached | AWS-managed network: internet access, no route into any customer VPC | execution role, credentials in the environment |
| Lambda, VPC-attached | an ENI in the configured subnets with the function's security groups; internet only through NAT | execution role |
| Other compute (ECS/Fargate, EKS pods, CodeBuild, ...) | ENI in a subnet, or AWS-managed | task/pod/build role |
| AWS service acting for you (S3 event delivery, CloudFormation, ...) | AWS-managed, no VPC | service principal, with `aws:SourceArn` / `aws:SourceAccount` / `aws:CalledVia` |

A context is declared as data (kind plus references into the emulated account's state, for example `{ kind: "ec2", instanceId }` or `{ kind: "lambda", functionName }`) and the network position and identity are *derived* from that state (instance -> ENI -> subnet -> route table), so changing a route table or security group changes the outcome. Credentials come from the existing mechanisms (`sts:AssumeRole` sessions, `issueSession`), and an IMDS endpoint is part of the EC2 context.

### What the network layer decides

- **DNS.** The VPC resolver (`enableDnsSupport`, `enableDnsHostnames`), instance and public DNS names, Route 53 private hosted zones associated with the VPC, and interface endpoints with private DNS (which make the service hostname resolve to the endpoint ENI instead of the public service address). The same name can resolve differently from different contexts.
- **Routing.** Most specific route wins in the subnet's route table (explicit association, else main): `local`, internet gateway, NAT gateway, gateway endpoints (S3/DynamoDB prefix lists), transit gateway, peering, VPN. Internet access needs a public IP and an IGW route, or a NAT in a public subnet; the return path matters.
- **Filtering.** Security groups (stateful, evaluated at both ends, referencing other groups) and network ACLs (stateless, ordered rules, ephemeral ports on the return path).
- **Reaching AWS APIs.** Public endpoint (via IGW/NAT), interface endpoint (private IP in your subnet, endpoint security group, endpoint policy), or gateway endpoint. Which path is taken determines which context keys exist.

### Request context for IAM

The network layer, not the client, knows these facts, so it attaches them to the request and the policy engine consumes them as condition keys. Examples of keys that must be right, including their quirks:

- `aws:SourceIp` is the public IP the service sees, and is **absent** for requests that arrive through a VPC endpoint (there you get `aws:VpcSourceIp`, `aws:SourceVpc`, `aws:SourceVpce`).
- `aws:SourceVpc` / `aws:SourceVpce` only exist for requests through a VPC endpoint; `aws:VpceAccount`, `aws:VpceOrgID`, `aws:VpceOrgPaths` describe the endpoint's owner.
- Service-to-service calls: `aws:SourceArn`, `aws:SourceAccount`, `aws:CalledVia`, `aws:ViaAWSService`, `aws:PrincipalIsAWSService`, `ec2:SourceInstanceArn`.
- Request facts: `aws:SecureTransport`, `aws:UserAgent`, `aws:RequestedRegion`, principal tags and `aws:PrincipalOrgID` / `aws:PrincipalOrgPaths` (derived from the organization state).

Trust model: this is the same as `x-aws-principal` today. `proxy.ts` strips incoming context headers from external requests and only the emulated network layer may set them. The enriched context is the `context` argument of `authorize()`; the policy engine (identity policies, permission boundaries, session policies, SCPs, RCPs, resource policies, VPC endpoint policies) is the not-yet-built consumer, and the same engine should answer "can X do Y from Z" queries.

### Faked network library

The shim has to be easy to use without rewriting the code under test. Options, to be decided when the first one is built:

1. **Library replacement**: the code imports a compatible module (`requests`/`urllib3`-shaped) instead of the real one. Explicit, simple, works for any code that goes through that module.
2. **Hooking the HTTP layer of the SDK** (botocore's HTTP session, an `urllib3` pool manager) so unmodified boto3 code is routed through the emulated network.
3. **Patching at the socket/DNS level** (`getaddrinfo`, `connect`) so everything is covered, at the cost of being more invasive.

Python comes first because that is where the code under test lives; the emulated-network core should be language independent (a service this server exposes: "resolve", "connect", "send with context") with thin per-language shims on top.

### Building blocks (in dependency order)

1. **Network model as pure functions** over the EC2 state that already exists (`db/<account>/<region>/ec2.json`, records stored in API shape): DNS resolution, route lookup, SG and NACL evaluation, reachability with a hop-by-hop trace (the trace is the return value of every function, see [network-traces-plan.md](./network-traces-plan.md)). No sockets, fully unit-testable. **v0 exists** in `src/app/api/network/` (public names and addresses, internet gateway, public NAT gateway; see [walking-skeleton.md](./walking-skeleton.md)); the rest is listed there as "not modelled". Internet gateways, route tables, security groups and NACLs exist; NAT/EIP/ENI are the next EC2 phase, then Route 53 zones, VPC endpoints, peering and the other gateway attachments ([network-connectivity-plan.md](./network-connectivity-plan.md)).
2. **Request context and the policy engine**: define the context object, attach it in the network layer, and implement policy evaluation (including the keys above).
3. **Execution contexts**: EC2 (IMDS), Lambda (non-VPC and VPC), outside; deriving identity and position from state. Lambda goes first (no OS or user data to emulate, credentials arrive as environment variables, no Docker: the code runs as a Python subprocess behind the shim, `169.254.169.254` is intercepted by the shim, not bound). Plan: [lambda-plan.md](./lambda-plan.md).
4. **The shim**: Python first.
5. **Services behind the network**: VPC endpoints and their policies, S3/SQS/etc. endpoints whose resource policies use the context keys, peering and transit gateway. The S3 data plane (objects as files on disk) is planned in [s3-dataplane-plan.md](./s3-dataplane-plan.md): CloudFormation and Lambda depend on it, and the data-perimeter scenarios need its request context.

### Non-goals and open questions

- Not packet-level: no latency, bandwidth, MTU or eventual-consistency modelling initially; the question is "would this call be allowed and where would it go".
- Real instances or containers are not run; the code under test calls the shim.
- Open: how scenarios are declared and run (a Python context manager such as `with emulated.ec2(instance_id=...)`, a scenario file, or a subprocess started with an environment variable naming the context); how service-originated calls (S3 -> Lambda, CloudFormation with a role) are modelled; the canonical test cases to build against first (data-perimeter policies with `aws:SourceVpc` / `aws:PrincipalOrgID`, private-endpoint-only buckets, Lambda in a VPC without NAT reaching an AWS API).
- Accuracy is the metric: scenarios that run unchanged against a real account and compare the allow/deny result and the failing step are how the predictions get verified.

## Working with it

- `npm run dev`, then `./scripts/seed.sh` builds an organization (OUs, accounts, an SCP, a role and SSM parameters per account). It is idempotent and prints a CLI profile block for the member accounts.
- Profiles need `endpoint_url = http://localhost:3000/` **and** a `region`, in every profile (the endpoint is also used for the `AssumeRole` call). Session names must be at least 2 characters.
- Smoke test after any change: `aws --profile <p> sts get-caller-identity` for default and each member account, `ssm get-parameter --name /app/environment`, and a re-run of `seed.sh` (should change nothing).
- `src/app/api/db/credentials.ts` is excluded from Copilot edits in this workspace.

## Working principles

- **Read the existing code before adding any.** The services are built on generic parts (store, registry and protocol adapters, the model-driven EC2 decode/encode, `describe()` filtering and pagination, tag handling, ID generation). New operations and resources plug into them. Check what is already there, reuse it, and extend the generic code when it falls short; do not write a parallel implementation per operation. For EC2 the checklist is in `src/app/api/ec2/ec2.md` ("Adding an operation").
- **Emulate resource lifetime, not just API shapes.** Predicting what AWS does includes what happens over a resource's life: what it creates implicitly, what blocks its deletion (`DependencyViolation`), what is removed with it, and how other resources react (a VPC delete takes its main route table, default ACL and default security group with it; a subnet delete drops its associations). Resources added later (ENIs, NAT gateways, ...) must be wired into these checks. See "Resource lifetime" in `ec2.md`.
- **Say what was verified.** Passing Jest tests and a build are not verification against the dev server or AWS; record in the docs which behaviour is confirmed and which is written from memory.
- **Limits are quotas.** An account gets the default quotas of a real account, queryable with the Service Quotas API (not built yet), and operations enforce them through one registry (`src/app/api/quotas.ts`) instead of local constants. Finding quota problems before a real deployment is a goal of the app. See [quotas-plan.md](./quotas-plan.md).
- **Explain, do not just decide.** Network and authorization decisions return the steps that led to them (what was asked, found, decided and why), and anything not modelled is reported as such. See [network-traces-plan.md](./network-traces-plan.md).

What is planned, in which order and with which dependencies: [roadmap.md](./roadmap.md).

## Not implemented yet

- Policy evaluation of any kind: identity policies, permission boundaries, SCPs, resource policies, trust-policy conditions. SCPs and policies are stored only.
- IAM users, access keys, role tags, customer-managed policies.
- `MaxItems` / `Marker` pagination on IAM list calls.
- Services beyond account, organizations, iam, sts, ssm, servicequotas and the EC2 networking subset (kms, efs, cloudformation are stubs or docs only; S3, Lambda, Route 53, ACM, EC2 instances, volumes and everything not in `src/app/api/ec2/ec2.md` are not implemented). The plans for the next ones are listed in [roadmap.md](./roadmap.md).
- The emulated network, execution contexts, request-context enrichment and the faked network library described in "Execution contexts and the emulated network"; network reachability checks; CloudFormation engine.

## Refactor status

Done: store, service registry with protocol adapters, authorization hook, cleanup.

- **Store** (`src/app/api/db/store.ts`). The only code that knows the `db/` layout (`db/<service>.json`, `db/<account>/<service>.json`, `db/<account>/<region>/<service>.json`). The root is `DB_ROOT` (env `JPK_DB_ROOT`, default `db`). Writes go to a temp file and are renamed into place. `account`, `ssm`, `iam` and `organizations` use it; `credentials.ts` still does its own file access (it is excluded from Copilot edits, so migrate it by hand).
- **Registry and adapters** (`registry.ts`, `protocols.ts`). iam, sts, ssm, organizations, account and ec2 are on it; efs is a stub and still hand-rolls its route.
- **Authorization hook** (`authorization.ts`). The dispatcher calls `authorize({ principal, action: 'ssm:PutParameter', resources, context })` before every handler. The default authorizer always allows; `setAuthorizer()` installs a real one. The same engine should back a "can X perform Y" query.
- **Cleanup.** Dead modules removed, the legacy `error()` helper removed, db code throws `AwsError` (`ValidationException`, `ResourceNotFoundException`, `ParameterNotFound`, ...), debug logging dropped from the proxy.

Remaining:

1. Implement policy evaluation behind `setAuthorizer` (identity policies, boundaries, SCPs, resource policies).
2. Declare `resources` for the IAM and organizations operations (they default to `*`).
3. Move `credentials.ts` onto the store.
4. Move efs onto the registry when it gets a real implementation.

