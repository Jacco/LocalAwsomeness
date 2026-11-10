# EC2 networking

Protocol: EC2 query (`ec2` in the botocore model). Form body with `Action=` and `Version=2016-11-15`, XML response. Request parsing and response XML are generated from `data/aws/ec2-model.json` (`src/app/api/ec2/model.ts`), so parameter names (`Filter.1.Value.2`, `TagSpecification.1.Tag.1.Key`), element names and `<item>` lists match what the SDKs expect. Errors are `<Response><Errors><Error>` with HTTP 400 (412 for `DryRunOperation`). Operations without output return `<return>true</return>`.

State is one file per account and region: `db/<account>/<region>/ec2.json` (`src/app/api/db/ec2/state.ts`). Records are stored in the shape the API returns them. Every region starts with a default VPC (172.31.0.0/16, a /20 subnet per AZ, an internet gateway attached, main route table with a route to it, default NACL and security group, `isDefault`). It is created with the account for every region enabled by default (`provisionAccount`, called from `registerAccount`) and lazily on first use for other accounts and regions.

States are instant: a created VPC or subnet is `available` immediately. DryRun runs all validation and then answers `DryRunOperation` without saving.

## Implemented (phase 1 + 2 + 3 + part of 4)

| Area | Operations |
| --- | --- |
| Account | `DescribeAccountAttributes`, `DescribeRegions`, `DescribeAvailabilityZones` |
| Tags | `CreateTags`, `DeleteTags`, `DescribeTags` (and `TagSpecification` on create) |
| VPC | `CreateVpc`, `DeleteVpc`, `DescribeVpcs`, `ModifyVpcAttribute`, `DescribeVpcAttribute`, `AssociateVpcCidrBlock`, `DisassociateVpcCidrBlock`, `CreateDefaultVpc` |
| Subnet | `CreateSubnet`, `DeleteSubnet`, `DescribeSubnets`, `ModifySubnetAttribute`, `CreateDefaultSubnet` |
| Internet Gateway | `CreateInternetGateway`, `DeleteInternetGateway`, `AttachInternetGateway`, `DetachInternetGateway` |
| Route Table | `CreateRouteTable`, `DeleteRouteTable`, `CreateRoute`, `ReplaceRoute`, `DeleteRoute`, `AssociateRouteTable`, `DisassociateRouteTable`, `ReplaceRouteTableAssociation` |
| Security Group | `CreateSecurityGroup`, `DeleteSecurityGroup`, `AuthorizeSecurityGroupIngress`, `AuthorizeSecurityGroupEgress`, `RevokeSecurityGroupIngress`, `RevokeSecurityGroupEgress`, `ModifySecurityGroupRules`, `UpdateSecurityGroupRuleDescriptionsIngress`, `UpdateSecurityGroupRuleDescriptionsEgress`, `DescribeSecurityGroupRules` |
| Network ACL | `CreateNetworkAcl`, `DeleteNetworkAcl`, `CreateNetworkAclEntry`, `ReplaceNetworkAclEntry`, `DeleteNetworkAclEntry`, `ReplaceNetworkAclAssociation` |
| Elastic IP (partial) | `AllocateAddress`, `ReleaseAddress`, `DescribeAddresses`, `DisassociateAddress` |
| NAT Gateway (partial) | `CreateNatGateway`, `DeleteNatGateway`, `DescribeNatGateways` |
| Read-only | `DescribeRouteTables`, `DescribeNetworkAcls`, `DescribeSecurityGroups`, `DescribeInternetGateways`, `DescribeDhcpOptions`, `DescribeNetworkInterfaces` |

`CreateVpc` also creates the main route table, default network ACL, default security group (with its default rules) and attaches the account's default DHCP option set; `DeleteVpc` removes them. Terraform reads these back right after creating a VPC, which is why their Describe operations exist before their create operations do.

Every Describe supports the documented filters (including `tag:<key>`, `tag-key`, wildcards), ID lists with `NotFound`/`Malformed` errors, and `MaxResults`/`NextToken`. A few legacy camelCase filter names are accepted because the Terraform provider still sends them (`isDefault`, `cidrBlock`, `availabilityZone`, `defaultForAz`, ...).

### Phase 2 (internet gateways and route tables)

Internet gateways:
- `CreateInternetGateway` with optional `TagSpecification`
- `DeleteInternetGateway` rejects if IGW is attached to any VPC
- `AttachInternetGateway` and `DetachInternetGateway` manage VPC attachments
- Filters: `attachment.vpc-id`, `attachment.state`, `internet-gateway-id`, `owner-id`, `tag:<key>`, `tag-key`

Route tables:
- `CreateRouteTable` for a VPC; initializes with the local route (VPC CIDR -> local gateway)
- `DeleteRouteTable` fails with `DependencyViolation` while the route table has an association; this includes the main route table, which only goes with its VPC
- Routes:
  - `CreateRoute` adds a route to a destination (CIDR, IPv6 CIDR, or prefix list) via a target (IGW, ENI, VPC peering, NAT gateway, EC2 instance, TGW, EIGW, LGW, CGW, or CNI); rejects if destination already exists
  - `ReplaceRoute` updates an existing route (both are supported)
  - `DeleteRoute` removes a non-local route; rejects local routes
- Associations:
  - `AssociateRouteTable` binds a route table to a subnet; main route table association is implicit
  - `DisassociateRouteTable` removes a subnet->route table association (not the main association)
  - `ReplaceRouteTableAssociation` moves a subnet from one route table to another
- Filters: `vpc-id`, `route-table-id`, `owner-id`, `association.subnet-id`, `association.main`, `association.route-table-association-id`, `route.destination-cidr-block`, `route.destination-ipv6-cidr-block`, `route.gateway-id`, `route.state`, `route.origin`, `tag:<key>`, `tag-key`

### Phase 3 (security groups and network ACLs)

Security groups (`securitygroup.ts`). State keeps one record per rule (`securityGroupRules`, with its own `sgr-` ID); the group view groups them into `IpPermissions`/`IpPermissionsEgress` the way the API returns them.
- `CreateSecurityGroup` takes `GroupName` and `GroupDescription` (the wire name of `Description`), up to 255 characters of `a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*`; no `sg-` prefix, no `default` (`InvalidGroup.Reserved`); unique per VPC (`InvalidGroup.Duplicate`). Without `VpcId` the default VPC is used (`VPCIdNotSpecified` if there is none). A new group gets one allow-all egress rule. `TagSpecification` with `security-group`. Returns `GroupId`, `Tags`, `SecurityGroupArn`.
- `DeleteSecurityGroup` by ID, or by name in the default VPC. `CannotDelete` for the `default` group; `DependencyViolation` while a rule of another group references it or a network interface uses it (a rule of the group itself does not count). Its rules go with it.
- `AuthorizeSecurityGroupIngress`/`Egress` take `IpPermissions` or the shorthand (`IpProtocol`, `FromPort`, `ToPort`, `CidrIp`, `SourceSecurityGroupName`); not both (`InvalidParameterCombination`). One IpPermission with several sources becomes several rules. Sources: IPv4 range (stored canonical, `10.0.0.77/24` -> `10.0.0.0/24`), IPv6 range, security group of the same VPC, prefix list (none exist yet: `InvalidPrefixListID.NotFound`). Protocols `tcp`/`udp`/`icmp`/`icmpv6`/`-1` or a number (`6` is stored as `tcp`, ...); TCP and UDP need a port range within 0-65535, ICMP needs type and code (-1 to 255), other protocols have no ports (stored as -1). `InvalidPermission.Duplicate` for an existing rule, also within one request; the request is atomic. At most 60 rules per direction (`RulesPerSecurityGroupLimitExceeded`), counted separately for IPv4 and IPv6 rules; the limit is a quota of the account (see "Quotas"). `TagSpecification` with `security-group-rule`. Returns `SecurityGroupRules`.
- `RevokeSecurityGroupIngress`/`Egress` by `SecurityGroupRuleIds` or by specification (description is ignored when matching). A rule that does not exist is `InvalidPermission.NotFound` and nothing is revoked, except in the default VPC, where it is returned in `UnknownIpPermissions`. A rule ID of another group or direction is `InvalidSecurityGroupRuleId.NotFound`. Returns `RevokedSecurityGroupRules`.
- `ModifySecurityGroupRules` replaces rules in place (same ID, tags and direction are kept; an omitted description is removed). `UpdateSecurityGroupRuleDescriptionsIngress`/`Egress` by rule ID or by specification; an omitted description removes it.
- `DescribeSecurityGroupRules`: filters `group-id`, `security-group-rule-id`, `tag:<key>`, `tag-key`; IDs, `MaxResults`, `NextToken`.

Network ACLs (`networkacl.ts`).
- `CreateNetworkAcl` creates an ACL with only the final deny rule (32767) for ingress and egress; `TagSpecification` with `network-acl`; 200 per VPC (`NetworkAclLimitExceeded`). `ClientToken` is echoed, not used for idempotency.
- `DeleteNetworkAcl`: the default ACL cannot be deleted, and `DependencyViolation` while subnets are associated.
- `CreateNetworkAclEntry`/`ReplaceNetworkAclEntry`/`DeleteNetworkAclEntry`: rule number 1-32766 (32767 is the final deny rule and cannot be touched), unique per direction (`NetworkAclEntryAlreadyExists`), at most 20 per direction by default (`NetworkAclEntryLimitExceeded`, a quota); exactly one of `CidrBlock` (stored canonical) and `Ipv6CidrBlock`; protocol name or number stored as a number (`tcp` -> `6`); TCP/UDP need `PortRange`, ICMP/ICMPv6 need `IcmpTypeCode`, other protocols ignore both. Entries are listed egress first, then by rule number. Replace and delete need an existing entry (`InvalidNetworkAclEntry.NotFound`).
- `ReplaceNetworkAclAssociation` moves a subnet to another ACL of the same VPC and returns a new association ID (the same one when the subnet already uses that ACL).

Error codes for malformed IDs follow the API: `InvalidGroupId.Malformed` and `InvalidNetworkAclId.Malformed` (the `NotFound` codes are `InvalidGroup.NotFound` and `InvalidNetworkAclID.NotFound`).

### Phase 4, partial (Elastic IPs and NAT gateways)

Scoped by the [walking skeleton](../../../../docs/walking-skeleton.md): only what its scenarios and Terraform need. An operation accepts the parameters it handles and rejects the others with `UnsupportedOperation` naming the parameter (`assertSupported` in `request.ts`) — except parameters that are harmless, which a real client sends (the Terraform provider sends `NetworkBorderGroup` on `ReleaseAddress`, found when it was rejected).

Elastic IPs (`address.ts`), VPC scope only:
- `AllocateAddress` (`Domain` `vpc`, `NetworkBorderGroup` = the Region, `TagSpecification` `elastic-ip`); public addresses are stand-ins from `198.18.0.0/15`. 5 per Region by default (`AddressLimitExceeded`, a quota).
- `ReleaseAddress` by `AllocationId`; `InvalidIPAddress.InUse` while associated.
- `DescribeAddresses` with `AllocationId`, `PublicIp` and the documented filters.
- `DisassociateAddress` only as far as needed: Terraform calls it with the association it still has in its state when it destroys an address after the NAT gateway that held it. An association that is gone is `InvalidAssociationID.NotFound` (accepted by the provider); one held by a NAT gateway is `OperationNotPermitted`.

NAT gateways (`natgateway.ts`), public and private:
- `CreateNatGateway` with `SubnetId`, `AllocationId` (required for public, refused for private), `ConnectivityType`, `TagSpecification` `natgateway`, `ClientToken`. It creates a **requester-managed network interface** in the subnet (description `Interface for NAT Gateway nat-...`, `InterfaceType` `nat_gateway`, no source/destination check, the lowest free address of the subnet) and associates the Elastic IP with it. The Elastic IP must not be associated already (`Resource.AlreadyAssociated`). 5 per Availability Zone by default, counting `pending`, `available` and `deleting` (`NatGatewayLimitExceeded`).
- `DeleteNatGateway` removes the interface (the address goes back to the subnet) and frees the Elastic IP, which stays allocated to the account. The NAT gateway stays visible as `deleted` for an hour, as in AWS, and is then pruned.
- `DescribeNatGateways` with `NatGatewayId` and the filters `nat-gateway-id`, `state`, `subnet-id`, `vpc-id`, `tag:`; the filter parameter of this operation is called `Filter`. Errors are `NatGatewayNotFound` and `NatGatewayMalformed` (no `.NotFound` suffix).
- States are instant: `available` at once, `deleted` at once (AWS has `pending` and `deleting` in between).

What this changes elsewhere (the lifetime rules):
- A route's `State` is **derived from its target** in `DescribeRouteTables` (`effectiveRouteState`, `src/app/api/network/routes.ts`): a route to a deleted NAT gateway, or to an internet gateway that is detached or not attached to the VPC, is `blackhole` without anybody having to update the route. The `route.state` filter uses the derived value. `CreateRoute`/`ReplaceRoute` refuse a NAT gateway that does not exist or is deleted (`InvalidNatGatewayID.NotFound`).
- `AvailableIpAddressCount` of a subnet is **derived** from the interfaces in it (`availableAddressCount`, `db/ec2/interfaces.ts`: the subnet size minus the five reserved addresses minus the addresses of its interfaces). A full subnet fails with `InsufficientFreeAddressesInSubnet`.
- A subnet and a VPC cannot be deleted while a NAT gateway (through its interface) is in them; `DetachInternetGateway` fails with `DependencyViolation` ("mapped public address(es)") while a public NAT gateway exists in the VPC; an Elastic IP held by a NAT gateway cannot be released.
- Network interfaces per Region (5,000) is a quota; creating any interface counts toward it (`NetworkInterfaceLimitExceeded`).

## Not implemented yet
- **Rest of phase 4** (the part above is built; this is what no scenario needs yet, see [walking-skeleton.md](../../../../docs/walking-skeleton.md)):
  - `AssociateAddress` (an address with an interface or instance), `DescribeAddressesAttribute`, `ModifyAddressAttribute`, BYOIP and customer-owned pools, IPAM, secondary addresses of a NAT gateway.
  - `CreateNetworkInterface`, `DeleteNetworkInterface`, `ModifyNetworkInterfaceAttribute`, `AssignPrivateIpAddresses`, `UnassignPrivateIpAddresses`, `AttachNetworkInterface`/`DetachNetworkInterface` (attachment needs instances). Interfaces exist only as requester-managed records created by NAT gateways and by Lambda functions in a VPC (one shared interface per subnet and security group set, see `src/app/api/lambda/lambda.md`; endpoints will create them the same way).
  - NAT gateway idempotency (`ClientToken` is echoed, not used), `PrivateIpAddress`, regional and zonal availability modes, a NAT gateway being in the same VPC as the route that points at it (not checked), the `pending` and `deleting` states (states are instant).
  - Quotas not enforced yet: Elastic IPs per public NAT gateway (one address per NAT gateway), security groups per network interface.
- **After phase 4**: VPC endpoints (interface and gateway), then Route 53, peering and transit gateways, see [network-connectivity-plan.md](../../../../docs/network-connectivity-plan.md).
- Security group rules that use prefix lists or reference a group in a peered VPC or another account; managed and customer-owned prefix lists.
- `ClientToken` idempotency and VPC associations of security groups.
- IPv6 (CIDR associations, egress-only gateways) and IPAM: requests that ask for them return `UnsupportedOperation`.
- Authorization: operations run `authorize()` with `ec2:<Action>` and resource `*`; resource ARNs are not declared yet.

## Resource lifetime

The goal is to emulate the lifetime of AWS resources, not only their create/describe shape. For every resource, decide and implement what AWS does at each step, and test it:

- **Delete of a parent**: which children block it (`DependencyViolation`), which are removed with it, and which are left behind. Example today: `DeleteVpc` is blocked by subnets, an attached internet gateway, custom route tables/ACLs/security groups and network interfaces, but removes the main route table, default network ACL, default security group (and its rules) itself. `DeleteSubnet` drops its explicit route table and network ACL associations.
- **Implicit children on create**: what AWS creates for you (every VPC gets a main route table, default ACL, default security group and the region's DHCP options; the default VPC also gets an internet gateway, a `0.0.0.0/0` route and a subnet per availability zone).
- **State transitions and ownership**: attach/detach, associate/disassociate, which resources can only be removed through their parent (the main route table and its association, the `local` route, the default security group).
- **Resources that arrive later** (network interfaces, NAT gateways, Elastic IPs, endpoints, instances) must plug into the same checks: a subnet or VPC delete has to consider them, and the Describe-only resources that exist today (`networkInterfaces`) are already part of those checks. When adding a resource type, go through every existing delete path and add it where AWS blocks or cascades.

Anything here that is not confirmed against the AWS documentation or a real account goes in the "Not verified" list below.

## Quotas

Nothing in the EC2 code keeps its own limit. Operations ask `quota(scope, QUOTAS.<key>)` (`src/app/api/quotas.ts`) for the applied value of the account and region, and `hardLimit(...)` for limits nobody can change (tags per resource). Defaults are in `data/aws/quotas.json`, with the Service Quotas code and the documentation they were taken from. Enforced today: VPCs per Region (the default VPC counts), subnets per VPC, IPv4 CIDR blocks per VPC, network ACLs per VPC (the default one counts), rules per network ACL, security groups per Region (default groups count), rules per security group, Elastic IP addresses per Region, NAT gateways per Availability Zone, network interfaces per Region. When an operation gets a limit, add it to the data file and the registry in the same change. Plan: [docs/quotas-plan.md](../../../../docs/quotas-plan.md).

## Adding an operation

0. **Read what exists first.** The EC2 service is generic and model driven; most of an operation is already provided. Before writing code, read `request.ts`, `describe.ts`, `tags.ts`, `model.ts` and `service.ts`, plus the existing file for a neighbouring resource, and reuse:
   - request/response decoding and XML encoding: generated from `data/aws/ec2-model.json`, never hand-written per operation;
   - `find` / `KINDS` / `invalidValue` / `missing` (`request.ts`) for lookup, `*.NotFound` / `*.Malformed` errors and parameter errors;
   - `describe()` (`describe.ts`) for filters (`tag:`, `tag-key`, wildcards), ID lists, `MaxResults` and `NextToken`; a Describe operation may already exist in `describes.ts`;
   - `tagsFromSpecifications` / `validateTags` for `TagSpecification`, `newResourceId` / `newId` (`db/ec2/ids.ts`) for IDs;
   - `createVpc` and friends in `db/ec2/state.ts` for what a resource brings with it.

   Do not start from the API list and write each operation from scratch. If the generic code is missing something, extend it instead of working around it in one operation.
1. Add the name to `OPERATIONS` in `getec2model.py` and run `python3 getec2model.py`.
2. Write the `Op` (`(state, { scope, principal, params }) => result`) and register it with `read()` or `write()` in `service.ts`. `write` saves the state afterwards; return object members use the model's member names.
3. Work out the lifetime (see above): dependencies that block a delete, children created or removed, and the effect on the delete paths of the parent resources. Add the documented limits of the resource to the quota registry (see "Quotas") and enforce them in the operation.
4. Add a test to `src/app/api/__tests__/ec2.test.ts` (it runs the real stack against a temporary `db/` root), including the lifetime cases.
5. Run `npm run build` and the tests, then check against the dev server with boto3, the AWS CLI and Terraform (apply, empty plan, destroy) before calling an operation verified.

## Not verified against real AWS

Request/response shapes come from the botocore model and the API reference. Phases 1 to 3 were checked against the dev server with boto3, the AWS CLI and Terraform (AWS provider 6.x: apply, empty plan, destroy), using `scripts/verify-ec2/` (`main.tf`, `check.py`, `check.sh`; see the header of each for how to run it; they use the default AWS profile, so the bootstrap key of `db/tokens.json`). That proves the simulator is consistent with those clients, not that it matches AWS. The Terraform config must let the provider call `sts:GetCallerIdentity` on the simulator: with `skip_requesting_account_id` a referenced security group is read back as `<account>/<group id>` and every plan shows a diff. The following were written from memory of AWS behavior and should be confirmed against a real account:

- Error messages: invalid CIDR (`InvalidParameterValue`), `InvalidVpc.Range`, `InvalidSubnet.Range`, `InvalidSubnet.Conflict`, the availability zone message, `*.Malformed` message, `VpcLimitExceeded`, `SubnetLimitExceeded`, `CidrLimitExceeded`, overlapping secondary CIDR (`InvalidVpc.Range`), `DisassociateVpcCidrBlock` messages, `DefaultVpcDoesNotExist`, `MissingParameter` wording, `MaxResults` range message, `ModifyVpcAttribute` messages, tag resource type message, `AuthFailure` for a region that is not opted in.
- Which empty sets are emitted: tags and subnet `ipv6CidrBlockAssociationSet` are always present; a VPC without IPv6 omits `ipv6CidrBlockAssociationSet`.
- `BlockPublicAccessStates` on VPCs and subnets, and the DHCP/subnet attribute defaults.
- Availability zone letters and zone ids (`data/aws/regions.json` numbers zone ids in order; real accounts get a per-account mapping).
- CreateVpc/CreateSubnet return `available` (AWS reports `pending` first); chosen deliberately.
- IDs are `<prefix>-` plus 17 hex characters.
- Phase 2: the error code and message of `DeleteRouteTable` for the main route table, which route targets exist (`CreateRoute` only checks `GatewayId`, other targets such as NAT gateways and peering connections are accepted unchecked), the `Origin` after `ReplaceRoute`.
- Phase 3, security groups: messages of the parameter errors (port range, ICMP type/code, protocol, empty name or description, "no source"), the `InvalidPermission.Duplicate` message format, whether names are case sensitive, that a non-canonical CIDR is silently canonicalized instead of rejected, `DependencyViolation` message and that a self-referencing rule does not block deletion, the 60 rules per direction limit (AWS counts differently when a group is attached to interfaces, and where a reference to a security group is counted, IPv4 here), the `SecurityGroupLimitExceeded` message, `Return` of a `Revoke` that revoked nothing in the default VPC, `ModifySecurityGroupRules` replacing the whole rule, protocol names returned for numbers (`6` -> `tcp`, `58` -> `icmpv6`).
- Phase 4: the messages and codes of `AddressLimitExceeded`, `NatGatewayLimitExceeded`, `NetworkInterfaceLimitExceeded`, `Resource.AlreadyAssociated`, `InvalidIPAddress.InUse`, `OperationNotPermitted` for disassociating a NAT gateway's address, the `MissingParameter` and `InvalidParameterCombination` for a public or private NAT gateway, the `DependencyViolation` message of `DetachInternetGateway` ("mapped public address(es)"); that `InvalidNatGatewayID.NotFound` is the route error while `NatGatewayNotFound` is the NAT gateway error; that Elastic IPs per Region and network interfaces per Region are enforced per Region (AWS documents the interface limit per Availability Zone); the instant states; that the 198.18.0.0/15 pool is shared by no other account.
- Phase 3, network ACLs: the error for deleting the default ACL or an entry with rule number 32767 (`InvalidParameterValue` here), the messages for a missing port range or ICMP type/code, the 20 entries per direction limit, the error for moving a subnet to an ACL of another VPC, that a custom ACL starts with only the IPv4 deny entries.
