# Plan: two consoles

Status: planned. Today the UI is the default Next.js page (`src/app/page.tsx`, with Headless UI and Tailwind 4 available); everything is driven with the AWS CLI, SDKs and Terraform.

## Goal

Two web consoles inside this project, for the same simulator:

1. **The familiar console** (working name *mimic*): a deliberately simplified version of the AWS Management Console, so that what a person does in the real console can be done in the simulator, and screenshots, instructions and muscle memory carry over: sign-in, account and Region switchers, service search, a service page per service with the usual list, detail and create flows.
2. **The new console** (working name *studio*): a completely custom console with a much better interface for the things this app is for, rather than a copy of anything: understanding and testing a whole account or organization.

They are two front ends over one back end. Neither may bypass the simulator's own rules.

## Shared foundation

- **The consoles act as a principal.** Signing in selects an account and a principal (an IAM role or user, a role assumed with `AssumeRole`, the organization's management account), and every action the console performs is the AWS API operation that the real console would perform, run through the same registry path (decode, `authorize()`, handler) with that principal. So permission problems, quotas, dependency violations and errors look exactly like they do through the CLI, and the console is also a test of the API. No console-only back door into `db/`.
- **A UI-facing read layer** (`src/app/api/console/...`, plain JSON, not AWS wire protocols) that composes what a screen needs from several operations (a VPC page needs the VPC, its subnets, route tables, gateways, security groups, endpoints and what uses them), with the same authorization applied per underlying call. Screens never parse EC2 XML or call five endpoints from the browser.
- **Session handling**: sign-in produces a console session that holds temporary credentials issued by the existing STS path (`ASIA...` keys), as the real console does, so "who am I" and role switching behave like AWS. `proxy.ts` already sees UI requests and must exempt the console's own pages and API from SigV4 and use the console session instead.
- **A shared component library** (tables with the AWS-style filters and pagination, key/value detail panels, tag editors, JSON/policy editors, resource pickers, error banners that show the real error code and message, a "show the API call" panel that lists the operation and parameters behind each action, copyable as an AWS CLI command). Built on what is in the repo (React 19, Tailwind 4, Headless UI), no second UI framework.
- **Regions and accounts** as first-class context: the account switcher shows the accounts of the organization (or the snapshot), the Region selector uses the Regions enabled for the account.
- **Live data**: screens refresh from the API; state changes made by a CLI run or a Terraform apply show up without a reload (polling first, server-sent events later).
- **Trademarks, assets and copying**: the mimic console imitates the *structure* (navigation, page types, field names, the wording of API errors) and does not copy AWS's proprietary markup, CSS, icons, logos or marketing text. Use neutral icons, own styles and own wording; it must be clear that this is a simulator and not the AWS console.

## The familiar console (mimic)

Purpose: onboarding, demos, comparing with the real console, and a quick visual check that the state is what you expect. Scope grows with the services:
1. Sign-in page (account ID or alias, user or role, switch role), account/Region bar, home with recently visited services, service search.
2. **Read-only first**, service by service as they exist: VPC (VPCs, subnets, route tables, gateways, security groups, network ACLs), EC2 where it exists, IAM (roles, policies with JSON view), Organizations (tree), SSM Parameter Store, Service Quotas, KMS, S3, Lambda, CloudFormation (stacks, events, resources, outputs), Route 53.
3. **Create/edit/delete flows** for what is already scripted by Terraform and CLI, with the real validation errors.
4. Deliberate simplifications, documented: no wizards beyond what a flow needs, no charts of real metrics, no billing, no support or marketplace pages.

## The new console (studio)

Where the simulator can do things the real console cannot, and where the UI should be organised around questions, not around services:
- **"Can A reach B?"** The reachability and trace view: pick an execution context (a Lambda, an instance, outside) and a destination (a name, an address, a service call), run the network model, and see the hop-by-hop trace with the decisive route, security group rule, NACL entry and policy statement highlighted, on a diagram of the VPC. This is the main screen of the app and uses the trace format of [network-traces-plan.md](./network-traces-plan.md).
- **Network topology** of an account or a set of accounts: VPCs, subnets, route tables, gateways, endpoints, peering and transit attachments as a graph; select an element to see what depends on it and what deleting it would break (the dependency checks, made visible).
- **"Who can do what?"** The permission explorer: pick a principal, an action and a resource (and the request context), see the evaluation (SCP, boundary, identity policy, resource policy, key policy) with the deciding statement, and the KMS conflict report from [encryption-plan.md](./encryption-plan.md).
- **Quotas dashboard**: applied quotas, usage and headroom per account and Region, the requests made, and the report of quotas a template or scenario would hit ([quotas-plan.md](./quotas-plan.md)).
- **Organization view**: OUs, accounts, attached policies and the effective SCP of any account.
- **Scenario runner**: define a scenario (context plus action), run it, keep the result and trace, re-run after changing the infrastructure and compare. Includes the comparison with a real run when one exists.
- **Snapshot browser and diff**: what was imported from a real account, what is modelled and what is only recorded, and the difference between two snapshots ([account-snapshot-plan.md](./account-snapshot-plan.md)).
- **CloudFormation stack explorer**: the dependency graph of a template, the order of creation, events with the real failure reasons, and what an update would replace.
- **Time and history**: an activity log of API calls with principal, request context and result (a CloudTrail-like view), the base for "what did my Terraform run actually do".

## Where it lives

`src/app/console/` for the familiar console and `src/app/studio/` for the new one (names open), each with its own layout, both using `src/app/components/` for the shared library and `src/app/api/console/` for the read layer. The default `/` page becomes a small landing page that links to both and shows the state of the simulator (accounts, Regions, datasets).

## Order

1. Foundations: console sign-in and session, the read layer for one service, the component library skeleton. One screen end to end (the VPC list and detail) proves the principal-based path.
2. **Studio first for the unique value**: the trace viewer and the topology view as soon as the network model produces traces ([walking-skeleton.md](./walking-skeleton.md)); a UI is also the best test of whether the traces are understandable.
3. Quotas dashboard (the Service Quotas API exists), then the permission explorer when the policy engine exists.
4. The familiar console, service by service, following the services as they are implemented, read-only before create flows.
5. Snapshot browser and scenario runner with the snapshot and scenario features.

## Open questions

- Should the two consoles be separate applications (separate route groups, separate builds) or one app with two themes? Recommended: one Next app, two route groups, one component library; a shared back end either way.
- Authentication of the console itself: a local-only simulator can start with a chosen principal per session; the sign-in page can still ask for account and principal, to exercise the same path as AWS.
- Real-time updates and long-running views (traces of a running scenario, CloudFormation events): polling or server-sent events.
- How "mimic" is the mimic: screens by service as listed, or a generic resource browser (a table per resource type generated from the API model, as the model is already machine-readable) with hand-built screens only for the important services. The generated browser is cheap and covers every service as it is added.
