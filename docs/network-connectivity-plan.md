# Plan: cross-account connectivity, Route 53 and the "outside" network

Status: planned. EC2 networking phases 1 to 3 exist (VPCs, subnets, internet gateways, route tables, security groups, network ACLs); this plan lists what comes next for connectivity between VPCs and accounts and for name resolution. It feeds the network model described in [architecture.md](./architecture.md#execution-contexts-and-the-emulated-network-design-not-started).

## 1. VPC peering

Operations: `CreateVpcPeeringConnection`, `AcceptVpcPeeringConnection`, `RejectVpcPeeringConnection`, `DeleteVpcPeeringConnection`, `DescribeVpcPeeringConnections`, `ModifyVpcPeeringConnectionOptions`.

- A peering connection has a requester and an accepter VPC, **in the same or another account and region**. The state is therefore in two places: each account's `ec2.json` holds its side, and the two sides must stay consistent. The request is made by the requester's principal and accepted by the accepter's principal (`ec2:AcceptVpcPeeringConnection` in the accepter account); an operation never writes into another account's state on behalf of a caller who has no right to do so. This is the first EC2 feature where one operation touches two accounts' state files, so it needs a store helper that loads and saves both (and a rule for what happens if the second write fails).
- States: `initiating-request`, `pending-acceptance`, `active`, `failed`, `rejected`, `expired` (not accepted in time), `deleting`, `deleted`. Same-account peering still needs the accept step.
- Rules: the CIDR blocks of the two VPCs must not overlap; peering is not transitive; one active connection between a pair of VPCs; DNS resolution across the peering is an option per side.
- Effects on the rest of the model:
  - `CreateRoute` with a `VpcPeeringConnectionId` target (today any target but `GatewayId` is accepted without checking) must verify that the connection exists and is active; routes to it work only while it is active.
  - **Route state follows the target.** Routes to a deleted peering connection, a detached or deleted internet gateway or a deleted NAT gateway become `blackhole`. Today `CreateRoute` stores `state: active` and never changes it; the state should be derived from the target when the route is read. (Known gap in phase 2.)
  - Security group rules can reference a security group in the peered VPC (`UserIdGroupPairs` with `UserId` and `VpcPeeringConnectionId`); today such references fail with `InvalidGroup.NotFound`, and `DescribeSecurityGroups` has to return the peering status of the pair. Stale references appear when the peering is deleted.
  - Deleting a VPC with an active peering connection, and what happens to the connection, to be verified against AWS.
  - The network model's route step gets a `pcx-` next hop that continues in the peer VPC (route table of the destination subnet for the return path, security groups of both ends, NACLs).
- Quotas: active and pending peering connections per VPC, expiry time of a pending request; see [quotas-plan.md](./quotas-plan.md).

## 2. VPC endpoints (interface and gateway)

First-class, because they decide *how* a call to an AWS service leaves a VPC, and so which request context keys exist (`aws:SourceVpce`, `aws:SourceVpc`, `aws:VpcSourceIp`, no `aws:SourceIp`) and whether a private subnet without a NAT can reach a service at all. Variant E of the [walking skeleton](./walking-skeleton.md) needs one.

Operations: `CreateVpcEndpoint`, `ModifyVpcEndpoint`, `DeleteVpcEndpoints`, `DescribeVpcEndpoints`, `DescribeVpcEndpointServices` (the list of AWS services that offer endpoints, as reference data per Region in `data/aws/`), `DescribePrefixLists` (the managed prefix lists of the gateway services), `DescribeVpcEndpointServiceConfigurations` and the connection operations for endpoint services (PrivateLink to a service in another account).

- **Interface endpoints** (AWS PrivateLink): one network interface per chosen subnet (each takes an address from the subnet and counts toward interface and IP quotas), security groups on the endpoint (which gate access to the endpoint like any interface), an optional **private DNS** option that makes the service's public name (`sqs.eu-west-1.amazonaws.com`) resolve to the endpoint's interface addresses *inside the VPC* (needs `enableDnsSupport` and `enableDnsHostnames`), the endpoint's own DNS names, and an **endpoint policy** (a resource policy on the path, evaluated in addition to the identity policy and the service's resource policy). Endpoint services of other accounts (`com.amazonaws.vpce.<region>.vpce-svc-...`) need the provider's acceptance.
- **Gateway endpoints** (S3 and DynamoDB only): no interface; the endpoint adds a route to the **managed prefix list** of the service in the chosen route tables (a route with a `vpce-` target), and an endpoint policy. They work by routing, not by DNS: the public service name still resolves to a public address, and the route to that prefix list sends it through the endpoint. They are selected by route table, and the S3 prefix list is what a security group or NACL egress rule can name.
- Network model: the DNS step consults endpoints (private DNS), the route step knows `vpce-` targets and prefix lists, the security group step applies to the endpoint's interfaces, and the delivery step produces the endpoint context. The trace says which path was used and why another was not ("an interface endpoint for `sqs` exists in `vpc-...` but its private DNS is disabled, so the name resolves to the public address and the NAT route is used").
- Lifetime: deleting an endpoint removes its interfaces and routes; a gateway endpoint's routes turn `blackhole` when it goes; a security group used by an endpoint interface cannot be deleted; a subnet with endpoint interfaces cannot be deleted; endpoint services with active connections cannot be deleted.
- Quotas: endpoints per Region, gateway endpoints per VPC, interface endpoints per VPC, security groups per interface, addresses per subnet; through the registry.
- Without an emulated service behind them, the endpoints still matter: the context is attached and the policy checks run on the call, so a scenario about "this bucket only accepts the endpoint" can run as soon as the bucket and its policy exist ([s3-dataplane-plan.md](./s3-dataplane-plan.md)).

## 3. Gateway attachments

"Gateway attachments" for cross-account networking. Interpretation to confirm: the gateways that connect a VPC to other networks, in this order of value:
1. **Transit gateway** with VPC attachments, TGW route tables, associations and propagations, **shared with other accounts through Resource Access Manager** (the usual multi-account design: a network account owns the TGW and the member accounts attach their VPCs); attachment states (`pendingAcceptance`, `available`) and the accept step in the owner account.
2. **Virtual private gateway and VPN connections, customer gateways, Direct Connect gateways**, as the attachment points from outside AWS (the "on-premises" execution context).
3. **Endpoint services (PrivateLink) shared across accounts**: interface endpoints to a service in another account are cross-account attachments (the provider accepts the connection). The endpoints themselves, interface and gateway, are section 2.
4. **Shared subnets** (RAM subnet sharing in an organization): a subnet owned by one account used by others, which changes who owns ENIs and security groups in it.

`AttachInternetGateway` / `DetachInternetGateway` already exist and set the pattern for the lifetime checks (attachment states, routes becoming `blackhole`, dependency errors on delete). Resource Access Manager and the organization sharing setting (`EnableSharingWithAwsOrganization`) are a prerequisite for 1 and 4 and use the organization state that exists.

## 4. Route 53 (basic)

A global service (REST XML, `/2013-04-01/...`, signed for `us-east-1`).

- **Hosted zones** public and private: `CreateHostedZone` (with `VPC` for private ones), `GetHostedZone`, `ListHostedZones`, `ListHostedZonesByName`, `DeleteHostedZone` (`HostedZoneNotEmpty`), `AssociateVPCWithHostedZone` / `DisassociateVPCFromHostedZone` (cross-account associations need `CreateVPCAssociationAuthorization`), delegation sets and the NS/SOA records every zone starts with.
- **Records**: `ChangeResourceRecordSets` (atomic batch: `CREATE`, `UPSERT`, `DELETE`), `ListResourceRecordSets`, `GetChange` (`PENDING` then `INSYNC`), record types A, AAAA, CNAME, TXT, MX, NS, SRV, PTR, and **alias** records to other records and to AWS resources (load balancers, CloudFront, S3 website, API Gateway, another record). Routing policies beyond simple (weighted, latency, failover, geolocation, multi-value) and health checks come later; the model should leave room for them (a name resolves to a *set* of answers plus the policy that picks one).
- **Resolution rules** (this is what the network model's DNS step needs): from inside a VPC the resolver at the VPC base address + 2 answers; it uses private hosted zones associated with that VPC (requires `enableDnsSupport`, and `enableDnsHostnames` for the AWS-provided names), then public zones and public DNS, and the AWS-provided names (`ip-10-0-1-5.eu-west-1.compute.internal`, `ec2-<ip>.<region>.compute.amazonaws.com`, service endpoint names, interface endpoint names with private DNS). The most specific zone wins; a private zone shadows the public one of the same name from inside the VPC (split horizon). Route 53 Resolver endpoints and forwarding rules later.
- Lifetime: a zone with records other than NS/SOA cannot be deleted, deleting a VPC removes its zone associations (or is blocked, to verify), records that point at deleted resources stay (they are just data).

## 5. The "outside" context and intercepting traffic

Code running **outside** AWS (a laptop, CI, on-prem) resolves names with the real internet DNS and connects with real sockets. To simulate it, the shim in front of the code under test must **intercept the traffic that is destined for the simulated network** and send it into the simulation instead of the internet:
- **Names owned by the simulation**: records of the public hosted zones, AWS service endpoints and the AWS-provided names (`<bucket>.s3.<region>.amazonaws.com`, `<api-id>.execute-api...`, `ec2-...compute.amazonaws.com`, ELB names) resolve through the emulated Route 53 and the emulated services, not through real DNS. Names of private hosted zones do **not** resolve from outside (NXDOMAIN), as in AWS.
- **Addresses owned by the simulation**: public IPs (Elastic IPs, auto-assigned public IPv4, NAT gateway addresses, load balancer addresses) are the "external" side of the emulated network. A connection to one of them from the outside context is delivered to the emulated target through the same route -> security group -> NACL steps (internet gateway, public IP mapping, the subnet's NACL, the security group of the target), and delivered to an emulated service or application endpoint. The outside context has no route table of its own; its source address is a configured public IP.
- **Everything else**: configurable policy: let it through to the real internet (default for a developer machine), fail with a clear error, or record it as "outside the model" in the trace. Unknown names are never silently treated as part of the simulation.
- **Reaching the simulator itself**: the shim also redirects AWS API calls to this server (`endpoint_url` today), so the code under test needs no configuration of endpoints. The request context (`aws:SourceIp` = the outside context's public IP) is attached by the shim, never by the client.
- A non-Python client (`curl`, a browser, a Java service) cannot use the Python shim: later options are a local DNS server answering from the emulated Route 53 plus a transparent proxy for the public IPs, with the same decisions and traces behind them.

All of it reports through the traces described in [network-traces-plan.md](./network-traces-plan.md).

## Order

1. Derived route state (`blackhole`) and target validation in `CreateRoute` (small, fixes a known phase 2 gap); part of the [walking skeleton](./walking-skeleton.md).
2. Phase 4 of EC2 (ENIs, Elastic IPs, NAT gateways) because public IPs and interfaces are what the outside context connects to; the skeleton needs a slice of it.
3. VPC endpoints, interface and gateway (section 2): the first step after the skeleton, because variant E of the skeleton and the data-perimeter scenarios need them. Needs Route 53 private zones only for the private DNS option, which can start with the endpoint's own name resolution.
4. Route 53 hosted zones and records; the DNS step of the network model on top.
5. VPC peering with the two-account store helper; peered security group references.
6. Endpoint services across accounts, then transit gateway and RAM sharing, then VPN/Direct Connect.
7. The outside-context interception in the shim, when the model and Route 53 can answer.

## Open questions

- "Gateway attachments": which of the gateways above is meant first (assumed: transit gateway attachments with RAM, then VPN/Direct Connect)?
- Fall-through policy for names and addresses the simulation does not own (default: real internet).
- How the outside context gets its public IP and whether several outside contexts (two offices, a VPN user) are needed at once.
- Cross-region peering and a second partition: the store is per account and region, so cross-region features need the same two-sided state discipline as cross-account ones.
