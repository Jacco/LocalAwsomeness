# Plan: snapshot a real account or organization into the simulator

Status: planned. The repository already has the beginning of this: `dumpaws.py` reads IAM roles and role policies, Lambda functions, S3 bucket policies and some resource types of one account through a boto3 profile and writes JSON files (`dumpaws.py`, `getpolicies.py`). This plan turns that into a proper capture-and-import pipeline.

## Goal

Query the APIs of a real AWS account, or of every account of an organization, and store the results in `db/` so the simulator **behaves like that account**: the same VPCs and routes, roles and policies, SCPs, keys, buckets, functions, quotas. Then every other goal of the app runs against something real: "can this Lambda reach that database", "would this template fit in the account's quotas", "who can use this key", with no cloud access needed after the capture, and with scenarios that can be compared with the real account.

## Safety first

A snapshot describes a real environment, so it is sensitive by nature.
- **Read-only by construction**: the capture uses a fixed allow-list of `Describe*` / `List*` / `Get*` calls; no call outside the list is made, and a run prints the list before it starts. The role to use is documented with a read-only policy (`ReadOnlyAccess`-like, plus the few extra `Get*` calls); nothing needs write access.
- **Never capture secrets or key material**: no SSM `SecureString` values (skip `WithDecryption`; store name, type, key ID), no Secrets Manager values, no KMS key material (only key metadata and policies), no certificate private keys, no IAM access keys or secret values, no S3 object contents by default, no Lambda environment variable values unless asked (names always, values only with an explicit flag and the redaction of anything that looks like a secret).
- **Keep it out of git**: snapshots go to a dedicated root (`snapshots/<name>/`, a configurable path), listed in `.gitignore` before the first run. The capture refuses to write inside a tracked directory.
- **Anonymisation (optional)**: a consistent remapping of account IDs, names, IP ranges and ARNs with a stored mapping, so a snapshot can be shared or used for tests without exposing the real environment. It must be consistent (the same ID everywhere, including inside policy documents and tags) and reversible only with the mapping file.
- A record of what was captured: account, time, the principal used, the list of calls, errors, and a content hash, so a snapshot can be audited.

## Two stages

1. **Capture** (needs real credentials): call the APIs and store the **raw responses** unchanged, one JSON file per call (or per resource type and region), with the request parameters, pagination handled, throttling retried with backoff, and failures recorded (an `AccessDenied` on a service is a finding, not a crash). Output: `snapshots/<name>/<account>/<region>/<service>/<operation>.json` plus an index.
2. **Import** (no credentials needed): transform the raw responses into the simulator's state (`db/...`) and start from there. Keeping the stages apart means the importer can improve and be re-run without touching the real account again, and a snapshot can be re-imported after the state format changes (`db/` is derived state, as the architecture notes say).

The EC2 state is already stored in the shape the API returns (`Describe*` output), so most of the importer for networking is mapping and splitting (security group `IpPermissions` into individual rules with `sgr-` IDs, route tables, associations). IDs are **kept** (a snapshot of `vpc-0abc...` is `vpc-0abc...` in the simulator), so results can be compared with the real account; new resources the simulator creates get new IDs as usual.

## What is captured, in the order the roadmap needs it

| Area | Content | Notes |
| --- | --- | --- |
| Organizations | organization, roots, OUs, accounts, policies of every type, attachments, delegated administrators | enumerates the accounts that the rest of the capture visits |
| IAM | roles with trust and permission policies, policies (customer-managed and the AWS-managed ones that are attached), boundaries, groups and users without credentials, instance profiles, account settings | builds on `dumpaws.py` |
| EC2 networking | VPCs, subnets, route tables, internet/NAT/transit gateways and attachments, security groups and rules, NACLs, network interfaces, Elastic IPs, endpoints and endpoint services, peering, DHCP options | the shapes the simulator stores |
| Route 53 and ACM | hosted zones and records, certificates (metadata and chain, no private keys) | |
| KMS | keys (metadata), aliases, key policies, grants, rotation | no key material |
| S3 | buckets and their configuration (policy, ACL, public access block, versioning, encryption, lifecycle, notifications, CORS); objects optional and off by default | object listing optional for the data plane |
| Lambda | functions with configuration, VPC config, role, environment variable names, event source mappings, resource policies; code optional | |
| CloudFormation | stacks, their templates, parameters, outputs, exports and resource lists | lets the simulator know the exports and imports of the real account |
| Service Quotas | applied quotas and usage (`ListServiceQuotas`) for every service in the snapshot | becomes the account's quota overrides, so quota scenarios use the real limits |
| Others, as needed | SSM parameters (names, types, no secure values), Secrets Manager (metadata), SQS/SNS, RDS (metadata, endpoints, subnet groups), load balancers, CloudWatch Logs groups | each appears when a scenario needs it |

Each resource type has a **support level** in the report: *modelled* (imported into state the simulator uses), *recorded* (kept as raw data, no behaviour), *skipped* (not captured). The completeness report lists, per account and region, what was captured, what failed and what the simulator does not model yet, so an incomplete picture is never mistaken for a complete one.

## Organizations

An organization snapshot captures the management account first (`ListAccounts`, policies, attachments), then each member account **by assuming a role in it** (`OrganizationAccountAccessRole` or a read-only role named in the configuration), for every enabled Region (or a list given). Each account's data lands under its own account ID in the simulator, together with the organization state that already exists (`db/<mgmt-account>/organization.json`), so SCP evaluation, cross-account roles and peering/sharing scenarios use the real structure. Accounts that cannot be assumed are recorded as unreachable and imported as the organization knows them (ID, name, OU) but empty.

## Importing into the simulator

- Import into a **named dataset**, not over the working `db/`: switching the simulator's `JPK_DB_ROOT` (it exists) to a snapshot import makes "simulate this account" a start-up choice, and the default dev data stays untouched. Importing must be repeatable and must not need the server to run.
- **Credentials** for the simulated principals are created locally (the real ones are never captured): the importer creates a simulator key for each role or user that scenarios want to act as.
- **Consistency checks after import**: every reference resolves (a subnet's VPC, a route's target, a function's role, a key policy's principals); dangling references are reported, as AWS has them too, instead of dropped.
- **Refresh and diff**: capture again later and show what changed between two snapshots (new resources, changed policies), so a scenario result can be tied to a snapshot date.

## Uses

- Run the connectivity and permission scenarios against the real network and IAM setup: Lambda in the real VPC, the real SCPs, the real key policies.
- **Quota planning**: import the real applied quotas and usage, then run a CloudFormation template or a Terraform plan and see which quota it would exceed ([quotas-plan.md](./quotas-plan.md)).
- **Accuracy checks**: the architecture notes name accuracy as the metric; a scenario that can be run in the real account can be run in its snapshot and the results compared, which is how the simulator's gaps are found.
- Regression data: an anonymised snapshot as a fixture for tests.

## Steps

1. Capture framework in Python (boto3, profile or assumed role, allow-list, pagination, throttling, raw responses plus index, completeness report), refactoring `dumpaws.py` into it; `.gitignore` and the secret rules first.
2. Importer for what the simulator models today: Organizations, IAM, EC2 networking, SSM (without secure values), Service Quotas into quota overrides.
3. Named datasets (switching the db root), consistency checks, anonymisation.
4. Organization capture through assumed roles.
5. More resource types as scenarios need them, KMS and Lambda and S3 configuration first.
6. Diff and refresh.

## Open questions

- Capture in Python (reuses `dumpaws.py`, `getpolicies.py` and boto3's paginators and retries) or in TypeScript with the AWS SDK for JS, so the server can offer it as a feature? Recommended: Python first, run from the command line.
- Where does the snapshot live by default, and how do several named datasets coexist next to the dev `db/`?
- How far to go with data (S3 objects, parameter values): the plan says off by default; a switch per resource type with a size cap is the likely answer.
- Anonymisation level: names only, or IP plan and policies as well.
