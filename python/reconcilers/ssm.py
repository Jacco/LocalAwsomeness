"""AWS::SSM::Parameter.

Properties: Name (generated when absent; change = replacement), Type (String | StringList; required), Value (required),
Description, AllowedPattern, DataType, Tier, Tags (a key/value map). Ref = Name; Fn::GetAtt: Type, Value.
"""
import secrets
import string
from typing import Any

from api_client import ApiError
from reconcilers import Reconciler, ResourceError, ResourceResult, UpdateResult, handler_message

SUPPORTED_PROPERTIES = {'Name', 'Type', 'Value', 'Description', 'AllowedPattern', 'DataType', 'Tier', 'Tags'}
TYPES = {'String', 'StringList'}
_ALNUM = string.ascii_letters + string.digits


def _invalid(logical_id: str, detail: str) -> ResourceError:
    return ResourceError(f'Properties validation failed for resource {logical_id} with message: {detail}')


def _scalar(value: Any, prop: str, logical_id: str) -> str:
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (str, int, float)):
        return str(value)
    raise _invalid(logical_id, f'#/{prop}: expected type: String, found: {type(value).__name__}')


class SsmParameterReconciler(Reconciler):
    resource_type = 'AWS::SSM::Parameter'
    replacement_properties = frozenset({'Name'})

    def create(self, logical_id: str, properties: dict[str, Any]) -> ResourceResult:
        props = self._validated(logical_id, properties)
        name = props.get('Name') or f'CFN-{logical_id}-{"".join(secrets.choice(_ALNUM) for _ in range(12))}'
        tags = [{'Key': k, 'Value': _scalar(v, f'Tags/{k}', logical_id)} for k, v in props.get('Tags', {}).items()]
        self.call('ssm', 'PutParameter', **self._put_params(name, props), **({'Tags': tags} if tags else {}))
        return self._result(name, props)

    def update(self, logical_id: str, physical_id: str, old: dict[str, Any], new: dict[str, Any]) -> UpdateResult:
        change = self.diff(old, new)
        if change.action == 'Replace':
            return UpdateResult(self.create(logical_id, new), replaced=physical_id)
        props = self._validated(logical_id, new)
        if change.action == 'Modify':
            if 'Tags' in change.properties:
                raise ResourceError(f'Updating Tags of {self.resource_type} {logical_id} is not supported by the '
                                    'simulator yet (AddTagsToResource/RemoveTagsFromResource)')
            self.call('ssm', 'PutParameter', **self._put_params(physical_id, props), Overwrite=True)
        return UpdateResult(self._result(physical_id, props))

    def delete(self, physical_id: str, properties: dict[str, Any]) -> None:
        try:
            self.api.call('ssm', 'DeleteParameter', Name=physical_id)
        except ApiError as e:
            if e.code != 'ParameterNotFound':  # already gone counts as deleted, as in CloudFormation
                raise ResourceError(handler_message(e)) from e

    def _validated(self, logical_id: str, properties: dict[str, Any]) -> dict[str, Any]:
        unknown = sorted(set(properties) - SUPPORTED_PROPERTIES)
        if unknown:
            raise _invalid(logical_id, f'#: extraneous key [{", ".join(unknown)}] is not permitted')
        for required in ('Type', 'Value'):
            if properties.get(required) in (None, ''):
                raise _invalid(logical_id, f'#: required key [{required}] not found')
        props = dict(properties)
        props['Type'] = _scalar(props['Type'], 'Type', logical_id)
        if props['Type'] not in TYPES:
            raise _invalid(logical_id, f'#/Type: {props["Type"]} is not a valid enum value '
                                       '(SecureString is not supported by CloudFormation)')
        props['Value'] = _scalar(props['Value'], 'Value', logical_id)
        if 'Tags' in props and not isinstance(props['Tags'], dict):
            raise _invalid(logical_id, '#/Tags: expected type: JSONObject')
        return props

    @staticmethod
    def _put_params(name: str, props: dict[str, Any]) -> dict[str, Any]:
        params = {'Name': name, 'Value': props['Value'], 'Type': props['Type']}
        for key in ('Description', 'AllowedPattern', 'DataType', 'Tier'):
            if props.get(key) is not None:
                params[key] = str(props[key])
        return params

    @staticmethod
    def _result(name: str, props: dict[str, Any]) -> ResourceResult:
        return ResourceResult(name, {'Ref': name, 'Type': props['Type'], 'Value': props['Value']})
