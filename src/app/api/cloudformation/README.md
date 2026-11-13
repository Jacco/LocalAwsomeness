# CloudFormation Service

Infrastructure as Code (IaC) stack management with template-based resource deployment.

## Status: Phase 1 - Core Stack Lifecycle

| Category | Operations | Status | Notes |
|----------|-----------|--------|-------|
| **Stack Lifecycle** | CreateStack, DescribeStacks, ListStacks, DeleteStack | ✅ Complete | Core CRUD operations |
| **Template Management** | ValidateTemplate, GetTemplate | ✅ Complete | Template storage and validation |
| **Change Management** | ExecuteChangeSet | ✅ MVP | Minimal implementation (no plan step yet) |
| **Resource Status** | DescribeStackResources | ✅ Complete | Track created resources |
| | Outputs | 🚀 Partial | Storage ready, SSM execution pending |
| **StackSets** | All | 🔲 Future | Multi-account/region deployment |
| **Drift Detection** | DetectStackDrift, etc. | 🔲 Future | Post-Phase 1 |

## API Endpoints

The service speaks the AWS **query protocol** (as real CloudFormation does), so the AWS CLI, boto3 and terraform work
against `http://localhost:3000/`: requests are form-encoded (`Action=CreateStack&StackName=...`, lists as
`Tags.member.1.Key=...`), responses are XML with lists as `<member>` elements, errors use the `ValidationError` code.
The JSON bodies below are a readable summary of the parameters, not the wire format.

```bash
aws cloudformation create-stack --stack-name my-stack --template-body file://template.json
```

### Deployment

`CreateStack` returns at once with the stack in `CREATE_IN_PROGRESS`, as in AWS; `deployment.ts` runs the Python engine
(`python/cf_deploy.py`) with the template, the previous resource state and the credentials of the deployment session,
and follows its events: resource events update `DescribeStackResources` and are recorded for `DescribeStackEvents`
(`events.jsonl` in the stack directory); the final event sets the stack status (`CREATE_COMPLETE`,
`ROLLBACK_COMPLETE`, ...) and the resource state for the next run. `DeleteStack` of a stack with deployed resources goes
to `DELETE_IN_PROGRESS`, deletes them through the engine, then removes the stack. `aws cloudformation wait
stack-create-complete` / `stack-delete-complete` work.

The interpreter is `JPK_PYTHON`, or the first `python3.x` >= 3.10 with boto3; `JPK_CF_ENGINE` replaces the engine script
(the jest tests use `__tests__/fixtures/fake-cf-engine.js`, which calls no API). The engine reaches the simulator at
`JPK_ENDPOINT_URL`, default `http://localhost:$PORT` (3000).

### Authorization

- Stack operations are authorized as `cloudformation:<Operation>` on `arn:aws:cloudformation:<region>:<account>:stack/<name>/*`
  (`ValidateTemplate`, `ListStacks` and `DescribeStacks` without a name: `*`). Denials are `AccessDenied` (403).
- A `RoleARN` on `CreateStack`/`DeleteStack` is an implicit `iam:PassRole` by the caller on that role, evaluated with
  `iam:PassedToService = cloudformation.amazonaws.com`. Then the role must exist and trust `cloudformation.amazonaws.com`,
  else `ValidationError: Role <arn> is invalid or cannot be assumed`.
- The deployment engine (`python/cf_deploy.py`) calls the service APIs with credentials from `deploymentSession()` in
  `role.ts`: a session of the service role (`assumed-role/<role>/AWSCloudFormation`), or without a role, of the caller.
  So each resource operation is authorized against the role's (or caller's) policies like any other request.

### Core Operations (Phase 1)

#### ValidateTemplate
Validate CloudFormation template syntax and resource declarations.

```json
POST /api/cloudformation
{
  "Action": "ValidateTemplate",
  "TemplateBody": "{\"AWSTemplateFormatVersion\":\"2010-09-09\",...}"
}
```

Response:
- `Description`: Template description
- `Parameters`: List of template parameters with types
- `Capabilities`: Required IAM capabilities
- `CapabilitiesReason`: Human-readable capability explanation

**Errors:**
- `ValidationError`: Invalid template syntax or missing required sections

---

#### CreateStack
Create a new stack from template.

```json
POST /api/cloudformation
{
  "Action": "CreateStack",
  "StackName": "my-app-stack",
  "TemplateBody": "{...}",
  "Parameters": [
    { "ParameterKey": "Environment", "ParameterValue": "prod" }
  ],
  "Tags": [
    { "Key": "Owner", "Value": "platform-team" }
  ],
  "TimeoutInMinutes": 30,
  "Capabilities": ["CAPABILITY_NAMED_IAM"]
}
```

Response:
- `StackId`: ARN of created stack (format: `arn:aws:cloudformation:region:account:stack/name/uuid`)

**Errors:**
- `AlreadyExistsException`: Stack with this name already exists
- `ValidationError`: Invalid template or parameters

**Lifecycle:**
1. Stack status: `CREATE_IN_PROGRESS`
2. Resources deployed (status varies by resource type)
3. ExecuteChangeSet → `CREATE_COMPLETE` or `CREATE_FAILED`
4. Can delete after `CREATE_COMPLETE`

---

#### DescribeStacks
Get detailed information about one or more stacks.

```json
POST /api/cloudformation
{
  "Action": "DescribeStacks",
  "StackName": "my-app-stack"    // Optional: if omitted, returns all stacks
}
```

Response:
- `Stacks[0]`:
  - `StackId`: Stack ARN
  - `StackName`: Human-readable name
  - `StackStatus`: Current status (CREATE_IN_PROGRESS, CREATE_COMPLETE, etc.)
  - `CreationTime`: ISO 8601 timestamp
  - `LastUpdatedTime`: ISO 8601 timestamp (if updated)
  - `Parameters`: Resolved parameter values
  - `Tags`: Stack tags
  - `Outputs`: Stack outputs (if any)
  - `Capabilities`: Required capabilities
  - `EnableTerminationProtection`: Whether deletion is protected

**Errors:**
- `ValidationError`: Invalid stack name or ARN format

---

#### ListStacks
List all stacks with optional status filtering.

```json
POST /api/cloudformation
{
  "Action": "ListStacks",
  "StackStatusFilter": ["CREATE_COMPLETE", "UPDATE_COMPLETE"]  // Optional
}
```

Response:
- `StackSummaries[]`:
  - `StackId`: Stack ARN
  - `StackName`: Name
  - `StackStatus`: Current status
  - `CreationTime`: ISO 8601
  - `LastUpdatedTime`: ISO 8601 (if applicable)
  - `DriftInformation`: Drift detection status (currently UNKNOWN)

**Stack Status Values:**
- `CREATE_IN_PROGRESS`: Stack creation in progress
- `CREATE_COMPLETE`: Stack created successfully
- `CREATE_FAILED`: Stack creation failed (manual deletion required)
- `UPDATE_IN_PROGRESS`: Stack update in progress
- `UPDATE_COMPLETE`: Stack updated successfully
- `UPDATE_FAILED`: Stack update failed
- `DELETE_IN_PROGRESS`: Stack deletion in progress
- `DELETE_COMPLETE`: Stack deleted (can be listed with StackStatusFilter)
- `ROLLBACK_IN_PROGRESS`: Rolling back failed create/update

---

#### GetTemplate
Retrieve the original CloudFormation template used to create a stack.

```json
POST /api/cloudformation
{
  "Action": "GetTemplate",
  "StackName": "my-app-stack"
}
```

Response:
- `TemplateBody`: Full JSON template
- `TemplateDescription`: Template description field
- `StagesAvailable`: ["Original"] (future: could include "Processed" for ChangeSet versions)

**Errors:**
- `ValidationError`: Stack not found

---

#### DeleteStack
Delete a stack and all its resources.

```json
POST /api/cloudformation
{
  "Action": "DeleteStack",
  "StackName": "my-app-stack"
}
```

Response:
- `StackId`: ARN of deleted stack

**Errors:**
- `ValidationError`: Stack not found or TerminationProtection enabled

**Lifecycle:**
1. Stack status: `DELETE_IN_PROGRESS`
2. Resources deleted (resource-specific cleanup)
3. Stack status: `DELETE_COMPLETE`
4. Stack still appears in ListStacks (with DELETE_COMPLETE status)

---

#### ExecuteChangeSet
Execute a changeset to deploy stack changes.

**MVP Implementation Notes:**
- Currently this is a simplified implementation
- Full CloudFormation has a two-step process: CreateChangeSet (plan) then ExecuteChangeSet (deploy)
- For Phase 1, ExecuteChangeSet immediately applies changes
- Future work will separate planning from execution

```json
POST /api/cloudformation
{
  "Action": "ExecuteChangeSet",
  "StackName": "my-app-stack",
  "ChangeSetName": "my-changeset"
}
```

Response:
- `StackId`: Stack ARN

**Errors:**
- `ValidationError`: Stack or changeset not found

**Lifecycle:**
- If stack is `CREATE_IN_PROGRESS`: transition to `CREATE_COMPLETE`
- If stack is `UPDATE_IN_PROGRESS`: transition to `UPDATE_COMPLETE`

---

#### DescribeStackResources
Get details about resources created by a stack.

```json
POST /api/cloudformation
{
  "Action": "DescribeStackResources",
  "StackName": "my-app-stack",
  "LogicalResourceId": "MyLambdaFunction",  // Optional: filter by logical ID
  "PhysicalResourceId": "arn:aws:lambda:..."  // Optional: filter by physical ID
}
```

Response:
- `StackResources[]`:
  - `LogicalResourceId`: Template-defined resource name (e.g., "MyLambdaFunction")
  - `PhysicalResourceId`: AWS resource ARN/ID (e.g., "arn:aws:lambda:...")
  - `ResourceType`: AWS service resource type (e.g., "AWS::Lambda::Function")
  - `ResourceStatus`: Status (CREATE_COMPLETE, UPDATE_COMPLETE, DELETE_COMPLETE, etc.)
  - `Timestamp`: ISO 8601 when status was set
  - `StatusReason`: Reason for failure (if applicable)
  - `StackId`: Parent stack ARN
  - `StackName`: Parent stack name

---

## Resource Support Plan

### Phase 1a: Simple Parameters (SSM)

**Resource Types Supported:**
- `AWS::SSM::Parameter`

**Parameters Template:**
```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: 'Simple parameter storage'
Resources:
  MyParam:
    Type: AWS::SSM::Parameter
    Properties:
      Type: String
      Value: 'my-value'
      Description: 'Example parameter'
Outputs:
  ParameterName:
    Value: !Ref MyParam
    Export:
      Name: MyParam
```

**Behavior:**
- Create: Store parameter in SSM storage
- Update: Modify parameter value (if Properties change)
- Delete: Remove parameter from SSM
- Output: Export parameter name for cross-stack use

**Timeline:** Immediate - leverages existing SSM service

---

### Phase 1b: Lambda Functions (with inline code)

**Resource Types Supported:**
- `AWS::Lambda::Function` (inline code only)
- `AWS::IAM::Role` (with assume role policy)
- `AWS::Lambda::Permission` (for cross-stack permissions)

**Parameters Template:**
```yaml
AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  FunctionName:
    Type: String
    Default: my-function
  Environment:
    Type: String
    Default: dev
Resources:
  ExecutionRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  
  MyFunction:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: !Sub '${FunctionName}-${Environment}'
      Runtime: python3.11
      Handler: index.lambda_handler
      Role: !GetAtt ExecutionRole.Arn
      Code:
        ZipFile: |
          def lambda_handler(event, context):
              return {'statusCode': 200, 'body': 'Hello from CFN!'}
      Environment:
        Variables:
          ENVIRONMENT: !Ref Environment

Outputs:
  FunctionArn:
    Value: !GetAtt MyFunction.Arn
    Export:
      Name: !Sub '${AWS::StackName}-FunctionArn'
```

**Intrinsic Functions Supported:**
- `!Ref` (parameter and resource references)
- `!GetAtt` (resource attributes)
- `!Sub` (string substitution)
- `!Join` (string joining)

**Behavior:**
1. Resolve all template parameters
2. Create IAM role with assume role policy
3. Create Lambda function with inline code
4. Set environment variables from template
5. Export outputs for other stacks

**Limitations (Phase 1):**
- Inline code only (no S3-based deployments)
- Python 3.11 default (can extend with Parameter)
- No VPC configuration yet (no network access)

**Timeline:** 2-3 days (leverages existing Lambda service)

---

### Phase 1c: Full Network Setup (VPC, Subnets, SecurityGroups)

**Resource Types Supported:**
- `AWS::EC2::VPC`
- `AWS::EC2::Subnet`
- `AWS::EC2::RouteTable`
- `AWS::EC2::Route`
- `AWS::EC2::SecurityGroup`
- `AWS::EC2::NetworkInterface`
- `AWS::EC2::VPCPeeringConnection`
- `AWS::EC2::TransitGateway` (StackSets: for multi-account)

**Example Template:**
```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: 'Full network stack with cross-stack imports'
Parameters:
  VPCCidr:
    Type: String
    Default: 10.0.0.0/16
  PrivateSubnetCidr:
    Type: String
    Default: 10.0.1.0/24
  PublicSubnetCidr:
    Type: String
    Default: 10.0.0.0/24

Resources:
  VPC:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: !Ref VPCCidr
      EnableDnsHostnames: true
      EnableDnsSupport: true
      Tags:
        - Key: Name
          Value: !Sub '${AWS::StackName}-vpc'

  PublicSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: !Ref PublicSubnetCidr
      AvailabilityZone: eu-central-1a
      MapPublicIpOnLaunch: true
      Tags:
        - Key: Name
          Value: !Sub '${AWS::StackName}-public-subnet'

  PrivateSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: !Ref PrivateSubnetCidr
      AvailabilityZone: eu-central-1a
      Tags:
        - Key: Name
          Value: !Sub '${AWS::StackName}-private-subnet'

  AppSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Security group for app tier
      VpcId: !Ref VPC
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 8080
          ToPort: 8080
          CidrIp: 10.0.0.0/16
      Tags:
        - Key: Name
          Value: !Sub '${AWS::StackName}-app-sg'

Outputs:
  VPCId:
    Value: !Ref VPC
    Export:
      Name: !Sub '${AWS::StackName}-VPCId'
  
  PublicSubnetId:
    Value: !Ref PublicSubnet
    Export:
      Name: !Sub '${AWS::StackName}-PublicSubnetId'
  
  PrivateSubnetId:
    Value: !Ref PrivateSubnet
    Export:
      Name: !Sub '${AWS::StackName}-PrivateSubnetId'
  
  AppSecurityGroupId:
    Value: !Ref AppSecurityGroup
    Export:
      Name: !Sub '${AWS::StackName}-AppSecurityGroupId'
```

**Cross-Stack Integration:**
```yaml
# In a separate application stack:
Resources:
  AppFunction:
    Type: AWS::Lambda::Function
    Properties:
      VpcConfig:
        SecurityGroupIds:
          - Fn::ImportValue: !Sub 'network-stack-AppSecurityGroupId'
        SubnetIds:
          - Fn::ImportValue: !Sub 'network-stack-PrivateSubnetId'
      # ... rest of Lambda config
```

**Behavior:**
1. Create VPC with specified CIDR
2. Create public and private subnets
3. Create security groups with ingress rules
4. Export subnet IDs and security group IDs
5. Other stacks import these exports via `Fn::ImportValue`

**Timeline:** 3-5 days (integrates with EC2 service)

---

## Testing Strategy

Tests use CloudFormation templates to validate functionality (CFN testing CFN).

### Test 1: Simple Parameter Export
```yaml
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  Config:
    Type: AWS::SSM::Parameter
    Properties:
      Type: String
      Value: 'test-value'
      Description: 'Test parameter'
Outputs:
  ConfigValue:
    Value: !Ref Config
    Export:
      Name: TestConfig
```

Expected:
1. Stack creates successfully
2. Parameter stored in SSM
3. Output exported with name "TestConfig"
4. Can retrieve via Fn::ImportValue

### Test 2: Lambda Deployment
Template with inline Python code, IAM role, environment variables.

Expected:
1. Stack creates successfully
2. IAM role created with assume role policy
3. Lambda function deployed with inline code
4. Environment variables set
5. Stack outputs include function ARN

### Test 3: Network Stack with Exports
VPC, subnets, security groups with full export/import.

Expected:
1. Network stack creates VPC, subnets, SGs
2. All resources exported with proper names
3. Application stack (in separate CreateStack call) can import and use exports
4. Lambda deployed in VPC with correct subnets/SGs

### Test 4: Cross-Stack Cleanup
Delete exported stack, verify imports fail gracefully.

Expected:
1. Dependent stack still exists (no cascade delete by default)
2. Can manually delete dependent stack
3. Then delete exported stack

---

## Implementation Roadmap

### Phase 1: Core (Current)
- [x] Stack CRUD (Create, Read, List, Delete)
- [x] Template validation and storage
- [x] Basic ExecuteChangeSet (MVP)
- [x] Stack resources tracking
- [ ] **Next: SSM Parameter resource type** (1 day)
- [ ] **Then: Lambda Function resource type** (2-3 days)

### Phase 2: Advanced Operations
- [ ] CreateChangeSet + planning (separate from execute)
- [ ] Stack updates (UpdateStack operation)
- [ ] Drift detection
- [ ] Event history
- [ ] Termination protection

### Phase 3: StackSets (High Priority)
- [ ] CreateStackSet, UpdateStackSet, DeleteStackSet
- [ ] CreateStackInstances for multi-account/region
- [ ] Auto-deployment to org accounts
- [ ] Deployment order (account/region batching)

### Phase 4: Advanced Features
- [ ] Custom resources
- [ ] Hooks
- [ ] Type registration
- [ ] Template generation/analysis
- [ ] Cost estimation

---

## Data Storage

```
db/
  {account}/
    cloudformation/
      stacks/
        {StackName}/
          stack.json              # Stack metadata (status, parameters, etc.)
          templates/
            v{N}.json             # Template body per version, pretty-printed (2-space indent)
            v{N}.kms.json         # KMS record: AWS owned key, encryption context, encrypted data key (the template stays plaintext)
          events.jsonl            # Stack events (DescribeStackEvents), oldest first
```

**Stack JSON Structure:**
```json
{
  "StackId": "arn:aws:cloudformation:region:account:stack/name/uuid",
  "StackName": "my-stack",
  "StackStatus": "CREATE_COMPLETE",
  "CreationTime": 1699850000000,
  "LastUpdatedTime": 1699850030000,
  "Parameters": [
    { "ParameterKey": "Environment", "ParameterValue": "prod" }
  ],
  "Resources": [
    {
      "LogicalResourceId": "MyParam",
      "PhysicalResourceId": "arn:aws:ssm:region:account:parameter/MyParam",
      "ResourceType": "AWS::SSM::Parameter",
      "ResourceStatus": "CREATE_COMPLETE",
      "Timestamp": 1699850005000
    }
  ],
  "Outputs": [
    {
      "OutputKey": "ParamName",
      "OutputValue": "MyParam",
      "ExportName": "MyParam"
    }
  ]
}
```

---

## Error Handling

Standard AWS CloudFormation errors:

| Error | Meaning | HTTP |
|-------|---------|------|
| `ValidationError` | Invalid input (template, parameters, etc.) | 400 |
| `AlreadyExistsException` | Stack already exists | 400 |
| `NotFoundException` | Stack or resource not found | 404 |
| `InsufficientCapabilities` | Missing IAM capabilities | 400 |
| `TypeNotFoundException` | Unsupported resource type | 400 |

---

## Future Enhancements

1. **StackSets**: Multi-account/region deployment with auto-targeting org accounts
2. **Drift Detection**: Compare template vs. actual resource state
3. **Change Sets**: Full plan/preview before execution
4. **Hooks**: Pre/post deployment validation
5. **Custom Resources**: Invoke Lambda for non-standard operations
6. **Type Registry**: Support custom resource types
7. **VPC Flow Logs Integration**: Log all CloudFormation-managed network traffic
8. **Cross-account Access**: Assume roles for multi-account deployments

---

## References

- AWS CloudFormation [Documentation](https://docs.aws.amazon.com/cloudformation/)
- Template [Syntax](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-anatomy.html)
- Intrinsic [Functions](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference.html)
- Best [Practices](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/best-practices.html)
