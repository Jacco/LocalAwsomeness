import os
import sys
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from api_client import ApiClient, ApiError  # noqa: E402
from reconcilers import ResourceError  # noqa: E402
from reconcilers.ssm import SsmParameterReconciler  # noqa: E402


class FakeApi:
    def __init__(self, fail: dict[str, ApiError] | None = None):
        self.calls: list[tuple[str, str, dict]] = []
        self.fail = fail or {}

    def call(self, service, operation, **params):
        self.calls.append((service, operation, params))
        if operation in self.fail:
            raise self.fail[operation]
        return {}


def reconciler(api=None):
    return SsmParameterReconciler(api or FakeApi(), 'stack')


BASE = {'Name': '/app/p', 'Type': 'String', 'Value': 'v1'}


class TestCreate:
    def test_puts_the_parameter_and_returns_ref_and_attributes(self):
        api = FakeApi()
        result = reconciler(api).create('P', {**BASE, 'Description': 'd', 'Tags': {'team': 'jpk', 'n': 1}})
        assert result.physical_id == '/app/p'
        assert result.attributes == {'Ref': '/app/p', 'Type': 'String', 'Value': 'v1'}
        assert api.calls == [('ssm', 'PutParameter', {
            'Name': '/app/p', 'Value': 'v1', 'Type': 'String', 'Description': 'd',
            'Tags': [{'Key': 'team', 'Value': 'jpk'}, {'Key': 'n', 'Value': '1'}]})]

    def test_generates_a_name_and_stringifies_scalar_values(self):
        api = FakeApi()
        result = reconciler(api).create('MyParam', {'Type': 'String', 'Value': 42})
        assert result.physical_id.startswith('CFN-MyParam-') and len(result.physical_id) == len('CFN-MyParam-') + 12
        assert api.calls[0][2]['Value'] == '42'

    @pytest.mark.parametrize('props, error', [
        ({'Type': 'String'}, 'required key [Value]'),
        ({'Value': 'v'}, 'required key [Type]'),
        ({**BASE, 'Type': 'SecureString'}, 'SecureString is not supported'),
        ({**BASE, 'Value': ['a']}, '#/Value: expected type: String'),
        ({**BASE, 'Tags': [{'Key': 'k'}]}, '#/Tags: expected type: JSONObject'),
        ({**BASE, 'Bogus': 1}, 'extraneous key [Bogus]'),
    ])
    def test_validates_properties(self, props, error):
        with pytest.raises(ResourceError, match=r'Properties validation failed for resource P') as info:
            reconciler().create('P', props)
        assert error in str(info.value)

    def test_reports_the_service_error(self):
        api = FakeApi({'PutParameter': ApiError('ssm', 'PutParameter', 'ParameterAlreadyExists', 'The parameter already exists.')})
        with pytest.raises(ResourceError, match=r'"The parameter already exists\." .*Error Code: ParameterAlreadyExists'):
            reconciler(api).create('P', BASE)


class TestUpdate:
    def test_no_change_makes_no_call(self):
        api = FakeApi()
        update = reconciler(api).update('P', '/app/p', BASE, dict(BASE))
        assert api.calls == [] and update.replaced is None and update.result.physical_id == '/app/p'

    def test_value_change_overwrites_in_place(self):
        api = FakeApi()
        update = reconciler(api).update('P', '/app/p', BASE, {**BASE, 'Value': 'v2'})
        assert api.calls == [('ssm', 'PutParameter', {'Name': '/app/p', 'Value': 'v2', 'Type': 'String', 'Overwrite': True})]
        assert update.replaced is None and update.result.attributes['Value'] == 'v2'

    def test_name_change_creates_the_new_one_and_leaves_the_old_for_cleanup(self):
        api = FakeApi()
        update = reconciler(api).update('P', '/app/p', BASE, {**BASE, 'Name': '/app/q'})
        assert [c[1] for c in api.calls] == ['PutParameter']
        assert 'Overwrite' not in api.calls[0][2]
        assert update.result.physical_id == '/app/q' and update.replaced == '/app/p'

    def test_tag_change_is_reported_as_unsupported(self):
        with pytest.raises(ResourceError, match='Updating Tags'):
            reconciler().update('P', '/app/p', {**BASE, 'Tags': {'a': '1'}}, {**BASE, 'Tags': {'a': '2'}})


class TestDelete:
    def test_deletes_and_treats_missing_as_deleted(self):
        api = FakeApi({'DeleteParameter': ApiError('ssm', 'DeleteParameter', 'ParameterNotFound', 'gone')})
        reconciler(api).delete('/app/p', BASE)
        assert api.calls == [('ssm', 'DeleteParameter', {'Name': '/app/p'})]

    def test_other_errors_fail_the_delete(self):
        api = FakeApi({'DeleteParameter': ApiError('ssm', 'DeleteParameter', 'AccessDeniedException', 'no')})
        with pytest.raises(ResourceError, match='AccessDeniedException'):
            reconciler(api).delete('/app/p', BASE)


def _server_available() -> bool:
    try:
        ApiClient('eu-central-1').caller_identity()
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _server_available(), reason='simulator not running at localhost:3000')
class TestAgainstSimulator:
    def test_lifecycle(self):
        api = ApiClient('eu-central-1')
        ssm = SsmParameterReconciler(api, 'stack')
        first, second = f'/cf-deploy-test/{uuid.uuid4()}', f'/cf-deploy-test/{uuid.uuid4()}'
        props = {'Name': first, 'Type': 'StringList', 'Value': 'a,b', 'Description': 'test'}
        try:
            ssm.create('P', props)
            stored = api.call('ssm', 'GetParameter', Name=first)['Parameter']
            assert (stored['Type'], stored['Value'], stored['Version']) == ('StringList', 'a,b', 1)

            with pytest.raises(ResourceError, match='ParameterAlreadyExists'):
                ssm.create('P', props)

            ssm.update('P', first, props, {**props, 'Value': 'a,b,c'})
            stored = api.call('ssm', 'GetParameter', Name=first)['Parameter']
            assert (stored['Value'], stored['Version']) == ('a,b,c', 2)

            update = ssm.update('P', first, props, {**props, 'Name': second})
            assert update.replaced == first
            assert api.call('ssm', 'GetParameter', Name=second)['Parameter']['Value'] == 'a,b'
            ssm.delete(update.replaced, props)
            with pytest.raises(ApiError, match='ParameterNotFound'):
                api.call('ssm', 'GetParameter', Name=first)
        finally:
            for name in (first, second):
                ssm.delete(name, props)
