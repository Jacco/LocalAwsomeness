To implement
============
list-users
list-groups

Prefix	Resource type
ABIA	AWS STS service bearer token
ACCA	Context-specific credential
AGPA    User group
AIDA    IAM user
AIPA	Amazon EC2 instance profile
AKIA	Access key
ANPA	Managed policy
ANVA    Version in a managed policy
APKA	Public key
AROA	Role
ASCA	Certificate
ASIA    Temporary (AWS STS) access key IDs use this prefix, but are unique only in combination with the secret access key and the session token.

ANPAZZSHNGWTLHYTXM3PP

User
====
CreateUser
DeleteUser
DeleteUserPermissionsBoundary
DeleteUserPolicy
DetachUserPolicy
GetUser
GetUserPolicy
ListAttachedUserPolicies
ListGroupsForUser
ListUserPolicies
ListUsers
ListUserTags
PutUserPermissionsBoundary
PutUserPolicy
RemoveUserFromGroup
TagUser
UntagUser
UpdateUser
AddUserToGroup
AttachUserPolicy

User SSH
========
DeleteSSHPublicKey
GetSSHPublicKey
ListSSHPublicKeys
UpdateSSHPublicKey
UploadSSHPublicKey

User AccessKey
==============
CreateAccessKey
DeleteAccessKey
GetAccessKeyLastUsed
ListAccessKeys
UpdateAccessKey

Group
=====
AttachGroupPolicy
CreateGroup
DeleteGroup
DeleteGroupPolicy
DetachGroupPolicy
GetGroup
GetGroupPolicy
ListAttachedGroupPolicies
ListGroupPolicies
ListGroups
PutGroupPolicy
UpdateGroup

Role
====
AddRoleToInstanceProfile
AttachRolePolicy
UntagRole
UpdateAssumeRolePolicy
CreateRole
CreateServiceLinkedRole
DeleteRole
DeleteRolePermissionsBoundary
DeleteRolePolicy
DeleteServiceLinkedRole
DetachRolePolicy
GetRole
GetRolePolicy
GetServiceLinkedRoleDeletionStatus
ListAttachedRolePolicies
ListInstanceProfilesForRole
ListRolePolicies
ListRoles
ListRoleTags
PutRolePermissionsBoundary
PutRolePolicy
RemoveRoleFromInstanceProfile
TagRoleUpdateRole
UpdateRoleDescription

Policy
======
CreatePolicy
DeletePolicy
GetPolicy
ListPolicyTags
ListPolicies
TagPolicy
UntagPolicy

Policy PolicyVersion
====================
CreatePolicyVersion
DeletePolicyVersion
GetPolicyVersion
ListPolicyVersions
SetDefaultPolicyVersion

Role InstanceProfile
====================
CreateInstanceProfile
DeleteInstanceProfile
GetInstanceProfile
ListInstanceProfiles
ListInstanceProfileTags
TagInstanceProfile
UntagInstanceProfile

Delegation
==========
AcceptDelegationRequest
AssociateDelegationRequest
CreateDelegationRequest
GetDelegationRequest
ListDelegationRequests
RejectDelegationRequest
SendDelegationToken ??
UpdateDelegationRequest

MFA
===
CreateVirtualMFADevice
DeactivateMFADevice
DeleteVirtualMFADevice
EnableMFADevice
GetMFADevice
ListMFADevices
ListMFADeviceTags
ListVirtualMFADevices
ResyncMFADevice
TagMFADevice
UntagMFADevice

AccountAlias
============
CreateAccountAlias
DeleteAccountAlias
ListAccountAliases

SAMLProvider
============
CreateSAMLProvider
DeleteSAMLProvider
GetSAMLProvider
ListSAMLProviders
ListSAMLProviderTags
TagSAMLProvider
UntagSAMLProvider
UpdateSAMLProvider

LoginProfile
============
CreateLoginProfile
DeleteLoginProfile
GetLoginProfile
UpdateLoginProfile

OpenID
======
AddClientIDToOpenIDConnectProvider
CreateOpenIDConnectProvider
DeleteOpenIDConnectProvider
GetOpenIDConnectProvider
ListOpenIDConnectProviders
ListOpenIDConnectProviderTags
RemoveClientIDFromOpenIDConnectProvider
TagOpenIDConnectProvider
UntagOpenIDConnectProvider
UpdateOpenIDConnectProviderThumbprint

SigningCertificate
==================
DeleteSigningCertificate
ListSigningCertificates
UpdateSigningCertificate
UploadSigningCertificate

ServerCertificate
=================
DeleteServerCertificate
GetServerCertificate
ListServerCertificates
ListServerCertificateTags
TagServerCertificate
UntagServerCertificate
UpdateServerCertificate
UploadServerCertificate

ServiceSpecific
===============
CreateServiceSpecificCredential
DeleteServiceSpecificCredential
ListServiceSpecificCredentials
ResetServiceSpecificCredential
UpdateServiceSpecificCredential

PasswordPolicy
==============
DeleteAccountPasswordPolicy
GetAccountPasswordPolicy
UpdateAccountPasswordPolicy

Miscelanious
============
ChangePassword

DisableOrganizationsRootCredentialsManagement
EnableOrganizationsRootCredentialsManagement
DisableOrganizationsRootSessions
EnableOrganizationsRootSessions
DisableOutboundWebIdentityFederation
EnableOutboundWebIdentityFederation
GetOutboundWebIdentityFederationInfo

GenerateCredentialReport
GenerateOrganizationsAccessReport
GetCredentialReport
GetOrganizationsAccessReport
GetAccountSummary
GetHumanReadableSummary

GenerateServiceLastAccessedDetails
GetAccountAuthorizationDetails

GetContextKeysForCustomPolicy
GetContextKeysForPrincipalPolicy
GetServiceLastAccessedDetails
GetServiceLastAccessedDetailsWithEntities
ListEntitiesForPolicy
ListOrganizationsFeatures
ListPoliciesGrantingServiceAccess
SetSecurityTokenServicePreferences
SimulateCustomPolicy
SimulatePrincipalPolicy
