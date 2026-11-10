# Plan: CloudFormation that processes real templates

Status: planned. Today `src/app/api/cloudformation/` only has `cloudformation.md`, a list of API operations. The README holds an older Python template parser (`TemplateParser`, section "This is for emulating CloudFormation").

## Goal

`CreateStack` / `UpdateStack` / `DeleteStack` / change sets take a real template (JSON or YAML) and do what CloudFormation does: validate it, resolve parameters, conditions, mappings and every intrinsic function, order the resources by their dependencies, and create, update and delete the resources by making **the real API calls** of the services behind them (`AWS::EC2::VPC` -> `CreateVpc`, ...), under the identity and quotas of the stack's role. The result is observable the way it is in AWS: stack and resource status, stack events with the real reasons, outputs, exports and imports, rollback on failure.

This is a prediction tool like the rest of the project: a template that fails in AWS because of a missing permission, a quota, a bad reference, a missing dependency or a resource that cannot be replaced should fail here, with the same explanation.

## Parts

### 1. Template parser (pure, no services)

Start from the README parser; it is the starting point, not the design (it stays Python, see "Language" below). What it already does: `Ref` (parameters, pseudo parameters, resources), `Fn::Sub`, `Fn::GetAtt`, `Fn::ImportValue`, `Fn::Join`, `Fn::Select`, `Fn::Split`, `Fn::GetAZs`, `Fn::FindInMap`, `Fn::Cidr`, `Fn::Length`, `Fn::Base64`, conditions (`Fn::If`, `Fn::Equals`, `Fn::Not`, `Fn::Or`, `Fn::And`, `Fn::Contains`), `AWS::NoValue`, resource-level `Condition`, SSM parameter parameter types and `{{resolve:ssm:...}}`.

Gaps to close:
- **Dependency-ordered resolution.** The README resolves the whole template in one pass with a `get_attribute` callback. A real engine resolves each resource when its dependencies exist (a `Ref` or `GetAtt` is only known after the other resource was created), so the parser must produce a dependency graph (`Ref`, `GetAtt`, `Fn::Sub` `${...}`, `DependsOn`) and resolve per resource, with cycle detection (`Circular dependency between resources`).
- YAML with the short forms (`!Ref`, `!Sub`, `!GetAtt a.b`, `!If`, ...), and the JSON/YAML differences of `Fn::GetAtt`.
- Dynamic references: `{{resolve:ssm:...}}`, `{{resolve:ssm-secure:...}}`, `{{resolve:secretsmanager:...}}` with the version and JSON key forms; they need the SSM / Secrets Manager services and the stack role's permissions.
- `Fn::ImportValue` against the real export registry, `Fn::ToJsonString`, `Fn::Transform` / `AWS::Include` / `AWS::Serverless` (SAM), `Fn::ForEach` (`AWS::LanguageExtensions`), `Fn::GetAZs` from `data/aws/regions.json`, `Fn::Cidr` correctness, `Rules`, `Metadata`, parameter constraints (`AllowedValues`, `AllowedPattern`, `MinLength`, `NoEcho`, typed parameters `AWS::EC2::VPC::Id` validated against state), `Outputs` with `Condition` and `Export`.
- Template validation errors with the CloudFormation wording (`ValidateTemplate`, `ValidationError: Template format error: ...`).

**Language (decided: keep the Python parser and call it from Node).** The server is TypeScript, but the parser already exists, works, and is the part with the most intrinsic-function details; a port would re-translate behaviour that is not yet covered by tests. Node calls Python through `child_process` with JSON over stdin/stdout, behind a narrow interface (`TemplateEngine`: analyze a template, resolve one resource) so a TypeScript implementation can replace it later without touching the stack engine. This only works if the parser is restructured first, which is the real work whichever language it ends in:
- **Pure and stateless.** No in-place mutation of the template and no `get_attribute` callback into the caller (a Python callable cannot call back into Node). Every call gets everything it needs as data: the template, parameter values, and a `known` map of the attributes of resources that already exist (`{ "Vpc": { "Ref": "vpc-...", "CidrBlock": "..." } }`).
- **Two calls instead of one `resolve()`.** `analyze(template, parameters)` returns the processed template (conditions evaluated, `Fn::Sub`/`Fn::Join`/`Fn::FindInMap`... that need no resource values already folded), the dependency graph, validation errors, and the **external lookups** the template needs (SSM parameters, exports for `Fn::ImportValue`, availability zones, dynamic references). Node answers the lookups from the emulated services under the stack role. `resolve_resource(template, logical_id, known, lookups)` then returns the final properties of one resource once its dependencies exist.
- **Long-lived worker**, not a process per call: Node starts one Python process, sends line-delimited JSON requests, matches replies by id, restarts it if it dies, and reports a clear error when `python3` or its packages (`netaddr`, `PyYAML` for the short-form tags) are missing. Python becomes a runtime dependency of the server, not only of the `get*.py` development scripts; say so in the README.
- **Tests on both sides.** Pytest for the parser (golden templates in, resolved JSON out), and a Node integration test that starts the worker. The same templates serve as the specification if the parser is ever ported.

### 2. Resource providers

A provider per resource type maps template properties to API calls and back: create, read (for `GetAtt` and `Ref` values), update, delete, plus the type's metadata. The metadata comes from the public CloudFormation resource schemas (`DescribeType`, or the downloadable schema bundle), as generated reference data like `ec2-model.json`: property names and types, `createOnlyProperties` (changing one means replacement), `readOnlyProperties` (the `GetAtt` attributes), `primaryIdentifier` (what `Ref` returns), required properties, and the update behaviour (`No interruption` / `Some interruption` / `Replacement`).
- Providers call the service **operations through the same registry path as a client** (decode -> authorize -> handler), not the state files, so authorization, quotas, dependency checks and lifetime rules all apply. The principal is the stack role (or the caller) and the request context says the call came from CloudFormation (`aws:CalledVia`, `aws:ViaAWSService`, `aws:PrincipalIsAWSService` rules): this is the "service acting for you" context of the architecture notes.
- Start with what exists: `AWS::EC2::VPC`, `Subnet`, `InternetGateway`, `VPCGatewayAttachment`, `RouteTable`, `Route`, `SubnetRouteTableAssociation`, `SecurityGroup`, `SecurityGroupIngress`/`Egress`, `NetworkAcl`, `NetworkAclEntry`, `SubnetNetworkAclAssociation`, `AWS::SSM::Parameter`, `AWS::IAM::Role`, and the CDK/CloudFormation basics (`AWS::CDK::Metadata`, `AWS::CloudFormation::WaitConditionHandle`...). Each new service adds its providers.
- Resources without a provider fail with the CloudFormation-style error rather than being skipped silently, so a template is never reported "fine" because we cannot handle part of it. A stub mode (create a placeholder with a made-up physical ID) can be an explicit option.

### 3. Stack engine

- **Stack state** in `db/<account>/<region>/cloudformation.json`: template (as submitted, plus the processed form), parameters, resolved resource states with logical ID, physical ID, type and properties, outputs, events, tags, role, termination protection, status.
- **Create / update / delete** with the real state machine: `CREATE_IN_PROGRESS` -> `CREATE_COMPLETE`, `ROLLBACK_IN_PROGRESS` -> `ROLLBACK_COMPLETE`, `UPDATE_ROLLBACK_*`, `DELETE_FAILED`, ... Resources are created in dependency order (independent ones may be created in any order), deleted in reverse; a failure rolls the stack back unless `DisableRollback`. `DeletionPolicy` (`Retain`, `Snapshot`, `Delete`) and `UpdateReplacePolicy` are honoured.
- **Updates** compute a diff against the previous resolved template: no change, in-place update, or replacement (create the new one, update references, delete the old one at cleanup). Change sets (`CreateChangeSet` / `DescribeChangeSet` / `ExecuteChangeSet`) show that diff before it is applied; `UPDATE_ROLLBACK_FAILED` and `ContinueUpdateRollback` exist.
- **Stack events** with the reason strings of the underlying API error (`Resource handler returned message: "The vpc 'vpc-...' has dependencies and cannot be deleted. (Service: Ec2, Status Code: 400, Request ID: ...)"`). The explanation is the product: it is what someone reads when a stack fails.
- **Exports and imports.** Exports are per account and region and unique by name; `ListExports`, `ListImports`; a stack cannot be deleted while another stack imports one of its exports, and an exported output that is in use cannot be changed.
- Nested stacks (`AWS::CloudFormation::Stack`, `TemplateURL`), `DescribeStackResources`, `DescribeStackResource`, `ListStackResources`, `GetTemplate`, `GetTemplateSummary`, `DescribeStackEvents`, `ValidateTemplate`, `DescribeAccountLimits`; StackSets, drift detection, resource import/refactor, registry types and hooks are later.
- `TemplateURL` and `AWS::CloudFormation::Stack` read the template from S3, and CDK assets are uploaded to S3: this needs the [S3 data plane](./s3-dataplane-plan.md). Until then only `TemplateBody` works.

### 4. Limits

Template size (inline and from S3), resources, parameters, outputs and mappings per template, stacks per region, and the quotas of every resource the stack creates, all through the [quota registry](./quotas-plan.md). A stack that would exceed a quota fails like it does in AWS; a report-only mode lists every quota the template would hit (this is the main way the app finds quota problems before deployment).

## Order

1. Restructure the Python parser into the stateless `analyze` / `resolve_resource` form with pytest golden tests (it needs no other service), then the Node wrapper around it.
2. Resource schemas as reference data and the provider interface.
3. Providers for the EC2 networking resources that exist, with `CreateStack` / `DeleteStack` / `DescribeStacks` / `DescribeStackEvents` / `DescribeStackResources` and rollback.
4. Updates, replacement and change sets; exports and imports.
5. S3-backed templates and assets; nested stacks.
6. Providers for each service as it is added.

## Verification

Golden templates (VPC with subnets and routing, a security-group web/db pair, a template that exceeds a quota, a template with a cycle, one with `Fn::ImportValue` of a missing export), each run against the simulator and, where possible, a real account, comparing final status, outputs and event reasons.

## Open questions

- Is a long-lived Python worker acceptable as a runtime dependency (Python 3 plus `netaddr` and `PyYAML` on every machine that runs the server)? If not, the fallback is the TypeScript port, with the golden tests above as its specification.
- How faithful must event timing and intermediate statuses be? Resources complete instantly today (`available` immediately); CloudFormation does not need delays, but event order and `*_IN_PROGRESS` entries should look right.
- How much of the CloudFormation registry (schemas for all resource types) to ship as reference data; schemas are large, so only for types that have a provider.
- CloudFormation-specific behaviours that need verification against a real account: replacement order, what `Ref` returns per type, the exact wording of events.
