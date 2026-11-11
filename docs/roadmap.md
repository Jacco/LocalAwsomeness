# Roadmap and plans

What is built, what is planned, and what depends on what. Each plan has its own file; this page only orders them. Plans are intent, not commitments: everything that says "from memory" in them still has to be verified against AWS.

## Done

- Foundations: store, service registry with protocol adapters, authorization hook ([architecture.md](./architecture.md)).
- EC2 networking phases 1 to 3: VPCs, subnets, internet gateways, route tables, security groups, network ACLs, tags, default VPC per region. Verified against the dev server with Terraform, boto3 and the AWS CLI (`scripts/verify-ec2/`). Reference: `src/app/api/ec2/ec2.md`.
- Quota registry (`src/app/api/quotas.ts`, `data/aws/quotas.json`, per-account overrides): every limit the code enforces goes through it.
- Service Quotas API (`src/app/api/servicequotas/`): read operations and quota increase requests. The enforcement record, the report and the generator script are still to do ([quotas-plan.md](./quotas-plan.md)).

## Plans

| Plan | One line | Depends on |
| --- | --- | --- |
| [walking-skeleton.md](./walking-skeleton.md) | **Built; ready to inspect by hand.** The first end-to-end test of the app's goal: a Lambda in a VPC calls an AWS API, four variants of the network give four explained results. Includes the shim spikes and the risks found | slices of EC2 phase 4, network model v0, shim v0, minimal Lambda |
| [quotas-plan.md](./quotas-plan.md) | Default account quotas, the Service Quotas API, enforcement through one registry, and a report of which quotas a deployment would hit | nothing; every other plan adds limits to it |
| [network-traces-plan.md](./network-traces-plan.md) | Traces and errors from the network simulation that say where a call wanted to go and why it did not work | the network model (architecture building block 1) |
| [network-connectivity-plan.md](./network-connectivity-plan.md) | VPC endpoints (interface and gateway), VPC peering, gateway attachments (transit gateway, VPN, shared subnets), Route 53, interception of traffic for the "outside" context | EC2 phase 4 for public IPs and interfaces |
| [lambda-plan.md](./lambda-plan.md) | Lambda as the first execution context, VPC attachment with shared interfaces, credentials, IMDS interception | EC2 phase 4, network model, request context, shim |
| [logging-architecture-decision.md](./logging-architecture-decision.md) | Technical analysis: how logging interacts with the network model, CloudWatch Logs permissions, and planned improvements (DNS resolver, logging as a network call) | documentation and planning; no implementation yet |
| [lambda-user-guide.md](./lambda-user-guide.md) | User guidance for writing Lambda code in the simulator: environment variables, known limitations (socket-level DNS), logging, permissions, virtual time, network traces | documentation |
| [future-features.md](./future-features.md) | Planned features: DNS server for multi-language support and private DNS, CloudTrail (light) for API audit logging | documentation and planning; no implementation yet |
| [s3-dataplane-plan.md](./s3-dataplane-plan.md) | S3 buckets and objects on the file system, versioning, event notifications to Lambda and others, the real API behaviour and request context | the REST XML adapter and proxy changes |
| [cloudformation-plan.md](./cloudformation-plan.md) | Real template processing: parser, intrinsics, imports/exports, resource providers that make the real API calls | parser: nothing; stacks: providers for existing services, S3 for `TemplateURL`, quotas |
| [encryption-plan.md](./encryption-plan.md) | KMS with fake encryption for services, real crypto for manual use, key policy conflict tracking; ACM with real certificates and TLS termination | the policy engine (conflicts), Route 53 (validation), S3 and others (integrations) |
| [account-snapshot-plan.md](./account-snapshot-plan.md) | Capture a real account or organization through its APIs and import it, so the simulator behaves like that account | the services to import into; real read-only credentials |
| [consoles-plan.md](./consoles-plan.md) | Two web consoles: a simplified mimic of the AWS console and a custom one built around traces, topology, permissions and quotas | the network model (studio), the services (mimic) |

## Suggested order

Scenario first: do not implement APIs fully until the end goal can be tested. Each step below implements only what the next scenario needs and states what is left out.

1. **Walking skeleton** ([walking-skeleton.md](./walking-skeleton.md)), in its own order: ~~network model v0 with traces as unit tests~~ (done), ~~the EC2 slice of phase 4: NAT gateway, Elastic IP, internal interfaces, derived route state~~ (done), ~~the model connected to the live state with a command to inspect a trace by hand~~ (done), ~~shim v0 with a runner~~ (done: variants A to D run end to end with boto3), ~~shim v0 with a runner~~ (done: variants A to D run end to end with boto3), ~~minimal Lambda~~ (done: variants A to D as a function through the Lambda API; see [lambda.md](../src/app/api/lambda/lambda.md)). Result: variants A to D of the scenario as a function, verified with boto3, the AWS CLI and Terraform.
2. **Make the recorded context matter**: *started*: identity-based policies of roles are evaluated behind `setAuthorizer` ([policy.md](../src/app/api/policy/policy.md): allow, explicit deny, implicit deny, AWS-style errors, a "can X perform Y" endpoint, conditions refused loudly). Next: the request context attached to requests (`aws:SourceIp`, `aws:SourceVpc`, `aws:SourceVpce`) so that conditions can be evaluated, SCPs and resource policies, or VPC endpoints and Route 53 (variant E), whichever the first real question needs. KMS key policies join the engine as the first resource policy that is also an access control of its own.
3. **S3 data plane** (versioning and events included), which unlocks the CloudFormation engine's `TemplateURL`, Lambda code from S3 and the perimeter scenarios; then the **CloudFormation engine** on the services that exist. The Python parser, restructured and wrapped for Node, can start earlier because it needs nothing else.
4. **Account snapshot** of a real account into a named dataset, as soon as there is enough to import into (Organizations, IAM, EC2 networking and quotas exist already): the first run against a real environment is the best accuracy test.
5. **Consoles**: the studio's trace viewer and topology as soon as traces exist, the familiar console as services appear.
6. KMS and ACM as the encryption plan orders them, VPC peering, transit gateways and the outside-context interception as scenarios need them, the EC2 instance context with IMDS after Lambda.

Quotas and the CloudFormation parser are independent of the network work and can go in parallel with it. A step is done when a scenario demonstrates it, not when its API is complete.

## Rules that apply to every plan

From [Working principles](./architecture.md#working-principles): read the existing code and reuse the generic parts; emulate resource lifetime (what is created implicitly, what blocks a delete, what goes with a parent); say what was verified and how. Added by these plans:
- A documented limit is enforced through the quota registry in the same change that implements the operation.
- A network or authorization decision returns its explanation (the trace) as part of its result.
- Anything not modelled is reported as "not modelled", never guessed.
