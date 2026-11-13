"""CloudFormation resource model shared by the parser, reconcilers and orchestrator.

Named cf_types (not types) so it does not shadow the standard library `types` module.
"""
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class Stage(str, Enum):
    START = 'START'
    PARSE = 'PARSE'
    PARSE_COMPLETE = 'PARSE_COMPLETE'
    CONNECT = 'CONNECT'
    CONNECT_COMPLETE = 'CONNECT_COMPLETE'
    COMPARE = 'COMPARE'
    COMPARE_COMPLETE = 'COMPARE_COMPLETE'
    EXECUTE = 'EXECUTE'
    EXECUTE_COMPLETE = 'EXECUTE_COMPLETE'
    SUCCESS = 'SUCCESS'
    ERROR = 'ERROR'


# Resource type -> local service that owns it. Types not listed here are rejected at parse time.
SUPPORTED_RESOURCE_TYPES: dict[str, str] = {
    'AWS::SSM::Parameter': 'ssm',
    'AWS::Lambda::Function': 'lambda',
    'AWS::IAM::Role': 'iam',
}


class TemplateError(Exception):
    """The template is invalid; maps to a CloudFormation ValidationError."""


@dataclass
class Resource:
    logical_id: str
    type: str
    properties: dict[str, Any] = field(default_factory=dict)
    depends_on: set[str] = field(default_factory=set)
    condition: Optional[str] = None
    deletion_policy: str = 'Delete'

    @property
    def service(self) -> str:
        return SUPPORTED_RESOURCE_TYPES[self.type]


@dataclass
class DeployConfig:
    stack_name: str
    template_body: str
    account: str
    region: str
    parameters: dict[str, Any] = field(default_factory=dict)
    endpoint_url: Optional[str] = None
    # {"accessKeyId", "secretAccessKey", "sessionToken"?} issued by the CloudFormation service (src/app/api/cloudformation/
    # role.ts): a session of the stack's service role, or of the caller. Absent: the default boto3 credential chain.
    credentials: Optional[dict[str, str]] = None
    # The stack's service role. The credentials must be a session of it; every API call is then authorized as that role.
    role_arn: Optional[str] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> 'DeployConfig':
        missing = [k for k in ('stackName', 'templateBody', 'account', 'region') if not data.get(k)]
        if missing:
            raise ValueError(f'Missing required config fields: {", ".join(missing)}')
        if data.get('roleArn') and not data.get('credentials'):
            raise ValueError('roleArn needs the credentials of the role session issued by the CloudFormation service')
        parameters = data.get('parameters') or {}
        # Accept the CloudFormation API shape [{ParameterKey, ParameterValue}] as well as a plain mapping.
        if isinstance(parameters, list):
            parameters = {p['ParameterKey']: p.get('ParameterValue') for p in parameters}
        return cls(
            stack_name=data['stackName'],
            template_body=data['templateBody'],
            account=str(data['account']),
            region=data['region'],
            parameters=parameters,
            endpoint_url=data.get('endpointUrl'),
            credentials=data.get('credentials'),
            role_arn=data.get('roleArn'),
        )
