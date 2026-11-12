# Policy evaluation (v0)

Identity-based policies of roles decide service calls. This is the first consumer of the authorization hook (`authorization.ts`, `setAuthorizer`): the registry calls `authorize({ principal, action, resources, context })` before every handler, and the default authorizer is `identityAuthorizer` (`authorizer.ts`). The rest of the engine (below) plugs in the same way.

## What is evaluated

- **Whose policies:** the principal of the request when it is a role, either `arn:aws:iam::<account>:role/<name>` or a session `arn:aws:sts::<account>:assumed-role/<name>/<session>`, and the role exists in IAM state (`db/<account>/iam.json`). Its **inline policies** and its attached **AWS managed policies** (the default version of the documents in `data/aws/managed-policies.json`) are the statements. There are no customer managed policies or users in IAM state yet.
- **Logic** (`engine.ts`, pure functions): an explicit `Deny` that matches wins; otherwise a matching `Allow` is needed; otherwise the request is denied implicitly. `Action` and `NotAction` match case-insensitively with `*` and `?`, `Resource` and `NotResource` with `*` and `?` (case sensitive). A request that names several resources needs all of them allowed.
- **Resources and actions** come from the operation declarations in each service (`resources` and `action` of the operation in `defineService`), like `arn:aws:lambda:<region>:<account>:function:<name>` for the Lambda operations. An operation that declares none is checked against `*`.
- **Exempt:** `sts:GetCallerIdentity` needs no permission, as the AWS documentation says ("No permissions are required to perform this operation", and an explicit deny does not stop it), so a function always can ask who it is, also with a role without any policy.
- **Not restricted:** identities the simulator holds no policies for: the account root, the bootstrap and test identities (`role/admin` of the development database is not in IAM state), roles that do not exist in IAM state. This keeps everything that existed before the engine working; to put a restriction on an identity, give it a role.

## Errors

In the form AWS uses: `User: <principal> is not authorized to perform: <action> on resource: <resource> because no identity-based policy allows the <action> action`, or `... with an explicit deny in an identity-based policy`. The code is `UnauthorizedOperation` for EC2 (with the prefix `You are not authorized to perform this operation.`), `AccessDenied` for IAM and STS, `AccessDeniedException` for the JSON and REST services, status 403.

When a statement that matches the request has a `Condition`, or a `Resource` with a policy variable (`${aws:username}`), the engine does **not guess** (an ignored condition makes an allow too wide and a deny too narrow): the call fails with `PolicyNotModelled` (status 501) and a message that names the statement. Conditions come with the request context (`aws:SourceIp`, `aws:SourceVpc`, ...), which is recorded on the traces of the network model but not yet attached to the requests the simulator receives.

## Asking without calling

`GET /api/policy/check?principal=<arn>&action=ec2:DescribeVpcs&resource=*` (an internal, unsigned endpoint like `/api/network/inspect`) answers "can this principal do this?" with the decision, the statement that decided, and every statement that was looked at with why it did or did not apply.

## Not evaluated yet

Service control policies and resource control policies (they are in the Organizations state), permission boundaries, session policies, resource-based policies (bucket policies, key policies, Lambda permissions, trust policies of other roles on the call itself), VPC endpoint policies, cross-account access (the principal's account is assumed to be the resource's), `iam:PassRole` on `CreateFunction`, conditions and policy variables (refused loudly, see above), customer managed policies and users.

## Not verified against real AWS

The exact wording and codes of the denial for each service (written from the documented format and from memory; only the EC2 form is known to have a longer message with an encoded part), the exempt list (only `sts:GetCallerIdentity` is documented as needing no permission), and the 501 for what cannot be evaluated (not an AWS behaviour, on purpose).

## Tests

`src/app/api/__tests__/policy.test.ts`: the logic, the role to policies mapping, the denial in the form each service uses, the exemption, resources, unknown identities, `PolicyNotModelled`, and the check endpoint. By hand: `python3 scripts/scenario/lambda.py --revoke` (the function gets `UnauthorizedOperation` for `ec2:DescribeVpcs`), then `--grant ec2:DescribeVpcs` (it works).
