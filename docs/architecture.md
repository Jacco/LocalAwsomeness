# Architecture notes

A local simulator of the AWS control plane. The AWS CLI and SDKs talk to this server; all state is JSON on disk. The goal is to answer questions about authorization and connectivity for a whole organization without touching a real account.

## Request flow

```
aws cli --endpoint_url http://localhost:3000
  -> src/proxy.ts            verify SigV4, resolve credentials, set x-aws-principal / x-aws-userid, rewrite URL
  -> src/app/api/<service>/  route handler for the service
  -> src/app/api/db/*        read/write JSON state under db/
```

- `proxy.ts` (Next 16 proxy, no matcher, so it also sees UI requests) re-signs the request with the stored secret and compares signatures. Unknown key, bad token, expired session and bad signature return AWS-shaped 403s (JSON or XML depending on content type). Incoming `x-aws-principal` / `x-aws-userid` headers are always stripped.
- Routing is derived from the credential scope (`service`). JSON services (`x-amz-target`) are rewritten to `/api/<service>/<TargetPrefix>/<Action>`; query and REST services to `/api/<service><path>`.

## Protocol styles in use

| Style | Services | Request | Helpers |
| --- | --- | --- | --- |
| Query / XML | iam, sts | form body with `Action=` | `src/app/api/query.ts` (`QueryParams`, `queryResponse`, `queryError`) |
| JSON 1.0/1.1 | organizations, ssm | JSON body, `x-amz-target` | `awsJson` / `awsJsonError` / `AwsError` in `src/app/api/common.ts` |
| REST-ish | account, efs | path per action | route files |

Errors: throw `AwsError(type, message, status)`. Older routes (ssm, account) still use `error()` from `common.ts`, which is not AWS-shaped, and some db code throws plain `Error`, which becomes a 500 `ServiceException`.

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

Every API call that changes state is persisted here, with policy documents stored as real JSON (stringified only in API responses). Files are read and written whole and synchronously, with no locking. `db/` is derived state: `scripts/seed.sh` should be able to rebuild it, so after a storage format change the clean migration is to delete the seeded accounts and re-seed.

## Reference data (`data/aws/`)

Read-only data AWS itself provides, shipped with the repo and never written by API calls (so it survives a `db/` reset). Loaded and cached by `src/app/api/db/reference.ts`.

| File | Contents |
| --- | --- |
| `managed-policies.json` | AWS-managed IAM policies (default version document, versions list, id, description), keyed by the ARN part after `policy/` (`ReadOnlyAccess`, `service-role/<name>`). Regenerate with `getpolicies.py` (needs real AWS credentials). Only the default version's document is stored. |
| `organizations-policies.json` | The built-in `FullAWSAccess` SCP and `RCPFullAWSAccess` RCP that AWS attaches automatically when the type is enabled. |

The IAM API serves these locally (`GetPolicy`, `GetPolicyVersion`, `ListPolicies`). Other AWS-provided data still hardcoded in code and candidates to move here: region lists (`db/common.ts`), SSM service-setting defaults (`db/ssm.ts`).

## Accounts and identity

- Member accounts are entered the way real AWS does it: `CreateAccount` creates `OrganizationAccountAccessRole` (trusting the management account root, `AdministratorAccess` attached); the caller uses `sts:AssumeRole` or a CLI profile with `role_arn` + `source_profile`.
- `AssumeRole` checks the role's trust policy (`Principal.AWS` only, conditions ignored) and issues a session credential stored in the target account.
- `x-aws-principal` is the caller ARN (`arn:aws:sts::<acct>:assumed-role/<role>/<session>` for sessions). The account of a request is the 5th `:` field of that ARN (`getRequestInfo`).

## Working with it

- `npm run dev`, then `./scripts/seed.sh` builds an organization (OUs, accounts, an SCP, a role and SSM parameters per account). It is idempotent and prints a CLI profile block for the member accounts.
- Profiles need `endpoint_url = http://localhost:3000/` **and** a `region`, in every profile (the endpoint is also used for the `AssumeRole` call). Session names must be at least 2 characters.
- Smoke test after any change: `aws --profile <p> sts get-caller-identity` for default and each member account, `ssm get-parameter --name /app/environment`, and a re-run of `seed.sh` (should change nothing).
- `src/app/api/db/credentials.ts` is excluded from Copilot edits in this workspace.
- `src/app/api/db.ts` is unused legacy (it has a compile error); `db/_organizations.ts` is an old copy of the organizations module.

## Not implemented yet

- Policy evaluation of any kind: identity policies, permission boundaries, SCPs, resource policies, trust-policy conditions. SCPs and policies are stored only.
- IAM users, access keys, role tags, customer-managed policies.
- `MaxItems` / `Marker` pagination on IAM list calls.
- Services beyond account, organizations, iam, sts, ssm (ec2, kms, efs, cloudformation are stubs or docs only).
- Network reachability checks, CloudFormation engine.

## Refactor direction (agreed, not started)

1. **One store module.** Each of `account.ts`, `ssm.ts`, `iam.ts` and `organizations.ts` has its own load/save JSON helpers and builds `db/<account>/...` paths itself. Replace with a single store keyed by `(account, region | global, service)`, with the `db/` root configured in one place and atomic writes.
2. **Service registry with protocol adapters.** Every service should register `action -> handler` and get a shared decoder/encoder per protocol (query, JSON, REST), so routes stop hand-rolling parsing, errors and responses. Handlers receive a context `{ principal, account, region, params }`.
3. **Authorization hook.** The dispatcher calls `authorize({ principal, action: 'ssm:PutParameter', resources, context })` before every handler. Start with an implementation that always allows. Handlers (or registry entries) declare the IAM action name and a resource ARN extractor so the later policy engine has what it needs. The same engine should back a "can X perform Y" query.
4. **Cleanup.** Remove the dead legacy modules, make all errors `AwsError`, and drop the debug `console.log` in the proxy.

Suggested order: store, then registry/adapters (migrating services one at a time, verified with the seed script and profile checks above), then the hook.
