# Plan: limits and quotas

Status: the registry, the reference data for the limits that exist today, per-account overrides and enforcement are **implemented**, and so is the **Service Quotas API** (`src/app/api/servicequotas/`, read operations and quota increase requests). The data is curated from the AWS documentation rather than generated. The enforcement record and the report are planned.

## Enforcement does not call the API

Operations never call the Service Quotas API to check a limit. They ask the registry in-process (`quota(scope, key)`), the same source the API reads, so there is no network hop, no authorization round trip and no way for the two to disagree. The API is the *view and management surface* of the registry: it reports applied values, creates increase requests and (through the approval policy) changes the applied value; the registry then enforces the new value on the next call. A test keeps the two in step: every quota the API lists reports the value the registry would enforce, and a quota raised through the API is honoured by an EC2 operation. What *does* use the API is client code: Terraform's `aws_servicequotas_*` resources, scripts that check headroom before a deployment, and the consoles.

## Goal

Every account gets the default quotas of a real account, they can be queried with the real API calls, and operations fail with the real error when a quota is exceeded. The point (README goal 4, "service quota") is to **discover quota problems without a real deployment**: run a template, a Terraform plan or a scenario against the simulator and learn which quota would have been hit, where, and by how much, before touching real infrastructure.

## What exists

- `data/aws/quotas.json`: one entry per limit, keyed by a symbolic key (`vpc.vpcs-per-region`): Service Quotas service and quota code (null for limits Service Quotas does not list), default, documented maximum, adjustable, global, unit, the documentation URL it was taken from and the date it was checked. Loaded by `quotaDefinitions()` in `src/app/api/db/reference.ts`.
- `src/app/api/quotas.ts`: `quota(scope, key)` (the applied value of an account: its override, else the default), `hardLimit(key)` (limits nobody can change, no account needed), `setQuota` / `resetQuota` (what an approved increase does, and how tests and scenarios lower a quota). The `QUOTAS` object lists the keys the code uses; a test checks that each has a definition with a source.
- Overrides are stored per account in `db/<account>/quotas.json`, only for values that differ from the default, per region for quotas that are per Region.
- Enforced through the registry now: VPCs per Region, subnets per VPC, IPv4 CIDR blocks per VPC, network ACLs per VPC, rules per network ACL, security groups per Region, rules per security group (inbound and outbound, IPv4 and IPv6 each counted separately), tags per resource, OU nesting depth, SCP and RCP size. The constants that used to be in `state.ts`, `request.ts`, `securitygroup.ts`, `networkacl.ts`, `vpc.ts` and `organizations.ts` are gone.

Corrections the documentation forced when the data was written (all were wrong or missing in the earlier code and notes):
- Security groups are limited **per Region** (2,500), not per VPC; the limit now exists.
- The rules-per-security-group quota is counted separately for IPv4 and IPv6 rules as well as per direction; a rule that references a security group counts as one rule, prefix lists count by their size (no prefix lists yet).
- The maximum size of a **service control policy is 10,240 characters**; 5,120 is the limit for resource control policies. Both were treated as 5,120.
- OU nesting is five levels under the root; the check allowed four.
- `MAX_CIDRS_PER_VPC` (a sixth hardcoded limit, in `vpc.ts`) is now a quota.

## Design

**Quota registry.** One module (`src/app/api/quotas.ts`) answers `quota(scope, key)` for an account and region. Operations ask it for the limit instead of using a constant, and compare it with the current usage. Keys are symbolic (`vpc.vpcs-per-region`) and map to the real Service Quotas `QuotaCode`, so what an operation enforces is exactly what the API reports.

**Reference data, not from memory.** Default values live in `data/aws/quotas.json`. Today the entries are copied from the AWS documentation (each names its URL and the date it was checked); the target is to generate the file with a script in the style of `getpolicies.py` / `getec2model.py` from the real `ListAWSDefaultServiceQuotas` (needs real credentials, run once and commit the result). Each entry keeps service, quota name, code, default value, `adjustable`, `global`, unit and the usage metric if there is one. Limits that Service Quotas does not list (tags per resource, SCP size, OU depth, rule number ranges, template size) are hard limits: they live in the same file with `adjustable: false`, no code, and a `source` note, and the generator must not overwrite them.

**Per account state.** `db/<account>/quotas.json` holds only the *overrides* of an account (applied values above or below the default). A new account has none, so it gets the defaults. Quotas are per region for most services and global for some; the key says which.

**The Service Quotas API** as a normal service on the registry (JSON 1.1, target prefix `ServiceQuotasV20190624`):
- `ListServices`, `ListServiceQuotas`, `GetServiceQuota`, `ListAWSDefaultServiceQuotas`, `GetAWSDefaultServiceQuota`: read, from the reference data plus the account's overrides.
- `RequestServiceQuotaIncrease`, `ListRequestedServiceQuotaChangeHistory`, `GetRequestedServiceQuotaChange`: a request is stored with a status. Approval policy is a simulator setting: automatically approved, approved up to a ceiling, or left pending/denied (to test what happens when AWS says no).
- Also usable from the control side: a way to *set* an account's quota directly (seed script, admin call), to test "what if this account only has 3 VPCs".

**Usage is derived, not counted.** Usage is computed from state when asked (number of VPCs in the region, rules in the group), the same way operations check it. No separate counters, so deleting a resource or editing `ec2.json` cannot make them drift. `GetServiceQuota` can report usage when the quota has a usage metric.

**Errors are the real ones.** `VpcLimitExceeded`, `SubnetLimitExceeded`, `RulesPerSecurityGroupLimitExceeded`, `NetworkAclEntryLimitExceeded`, `TagLimitExceeded`, `LimitExceededException`, `ConstraintViolationException`, ... with the service's real message. When one operation consumes several quotas, check them in the order AWS does (unknown; record it in the "not verified" list).

## Quota discovery report

The headline use: after running something, ask "what did this use against which quota?".
- Every enforced check records quota key, limit, usage after the call and the request that caused it (cheap, an in-memory log per account and region, optionally written to `db/`).
- A report operation (admin API, later UI) lists quotas by utilisation, highlights the ones reached, and names the first operation that failed and the resource it was for.
- It must also work in "report only" mode: do not fail the call, keep going, and list every quota that *would* have been exceeded. A real run stops at the first failure; a report that shows all of them at once is the useful one for planning.
- For rate limits (`RequestLimitExceeded`, throttling) the same registry can hold the request-rate quotas later; out of scope for the first version.

## Quotas that interact with other plans

- **IP addresses in subnets.** Running out of addresses is a quota problem in practice (`InsufficientFreeAddressesInSubnet`). `AvailableIpAddressCount` is currently a fixed number set at subnet creation; it must become derived from the network interfaces, NAT gateways and endpoints in the subnet (and the five reserved addresses). See the Lambda plan: Lambda functions with the same subnet and security group combination share one interface, which is what keeps this from running out quickly.
- **CloudFormation.** Stack and template limits (template size, resources, parameters, outputs, mappings per template, stacks per region) belong in the registry; see [cloudformation-plan.md](./cloudformation-plan.md).
- **S3.** Buckets per account, object and part size limits; see [s3-dataplane-plan.md](./s3-dataplane-plan.md).
- **Lambda.** Concurrency, function and code size, ENI-related limits.

## Steps

1. **Done, partly.** `data/aws/quotas.json` exists for the limits the code enforces, curated from the AWS documentation with the quota codes the documentation links to. Still to do: the generator script (`getquotas.py`, in the style of `getpolicies.py`) that dumps the full `ListAWSDefaultServiceQuotas` of a real account for the services that exist, which needs real credentials and replaces hand curation. Until then every addition is copied from the documentation with its URL and date.
2. **Done.** Registry module, per-account overrides, every constant replaced, tests (`quotas.test.ts`, the quota tests in `ec2.test.ts`, `organizations-limits.test.ts`).
3. **Done.** Service Quotas API: `ListServices`, `ListServiceQuotas`, `GetServiceQuota`, `ListAWSDefaultServiceQuotas`, `GetAWSDefaultServiceQuota`, `RequestServiceQuotaIncrease`, `GetRequestedServiceQuotaChange`, `ListRequestedServiceQuotaChangeHistory` and `ListRequestedServiceQuotaChangeHistoryByQuota`. Checked with the AWS CLI and boto3 (paginators and modelled exceptions included). The approval policy per account (`auto`, `pending`, `deny`) and `decideRequest` stand in for AWS Support. Not built: the templates and association operations (`GetAssociationForServiceQuotaTemplate`, ...), `ListTagsForResource`, usage metrics (`UsageMetric`, which needs CloudWatch), and operations on quotas applied at resource level.
4. Enforcement record and the report.
5. Add each future limit (ENIs per Region, Elastic IPs per Region and per NAT gateway, NAT gateways per AZ, security groups per network interface, IPs per subnet, ...) through the registry as its resource type arrives. Rule for new work: an operation that has a documented limit enforces it through the registry in the same change that implements the operation, with an entry that names its documentation source.

## Open questions

- Which regions and accounts have different defaults (new accounts often start with lower values than old ones)? Start with one default set, allow per-account overrides.
- Should the default set be a snapshot of one real account (comparable and reproducible) or the documented defaults? Prefer a snapshot, with its date in the file.
- Order of quota checks inside one operation, and which messages AWS uses for each: unknown until tested against a real account.
- Service Quotas behaviour written from memory in the API, to verify against a real account: the error codes and messages for a request that is not an increase (`IllegalArgumentException`), a second request while one is open (`ResourceAlreadyExistsException`), a request above the documented maximum (here `DENIED`), default page size (100), and the `RequestedQuota` fields that are filled (`CaseId` is never set here).
