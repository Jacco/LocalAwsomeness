import io
import json
import os
import sys
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from api_client import ApiClient, ApiError  # noqa: E402
from cf_parser import CloudFormationTemplate, TemplateContext, references  # noqa: E402
from cf_deploy import verify_identity  # noqa: E402
from cf_types import DeployConfig, Stage, TemplateError  # noqa: E402
from progress_reporter import ProgressReporter  # noqa: E402

CONTEXT = dict(account='123456789012', region='eu-central-1', stack_name='test')


def template(resources, **extra):
    return json.dumps({'Resources': resources, **extra})


def param(name='/x', value='v', **extra):
    return {'Type': 'AWS::SSM::Parameter', 'Properties': {'Name': name, 'Type': 'String', 'Value': value}, **extra}


def parse(body, **params):
    t = CloudFormationTemplate(body, TemplateContext(**CONTEXT, parameters=params))
    return t, t.parse()


class TestParser:
    def test_orders_by_depends_on_and_references(self):
        _, resources = parse(template({
            'C': param(value={'Fn::GetAtt': ['B', 'Arn']}),
            'B': param(value={'Fn::Sub': '${A}-x'}),
            'A': param(),
        }))
        assert [r.logical_id for r in resources] == ['A', 'B', 'C']
        assert resources[2].depends_on == {'B'}

    def test_condition_excludes_resource(self):
        t, resources = parse(template(
            {'A': param(), 'B': param(Condition='IsProd')},
            Parameters={'Env': {'Type': 'String', 'Default': 'dev'}},
            Conditions={'IsProd': {'Fn::Equals': [{'Ref': 'Env'}, 'prod']}},
        ))
        assert [r.logical_id for r in resources] == ['A']
        assert t.skipped == ['B']

    def test_resolves_properties_with_parameters_pseudo_params_and_attributes(self):
        t, _ = parse(template(
            {'A': param(), 'B': param(name={'Fn::Sub': '/${AWS::Region}/${Env}'}, value={'Fn::GetAtt': 'A.Value'})},
            Parameters={'Env': {'Type': 'String'}},
        ), Env='prod')
        props = t.resolve_properties('B', lambda logical_id, attr: f'{logical_id}:{attr}')
        assert props == {'Name': '/eu-central-1/prod', 'Type': 'String', 'Value': 'A:Value'}

    def test_no_value_removes_property(self):
        t, _ = parse(template({'A': {'Type': 'AWS::SSM::Parameter', 'Properties': {
            'Name': '/x', 'Type': 'String', 'Value': 'v', 'Description': {'Ref': 'AWS::NoValue'}}}}))
        assert 'Description' not in t.resolve_properties('A')

    @pytest.mark.parametrize('body, error', [
        ('', 'cannot be empty'),
        ('Resources: {}', 'only JSON'),
        ('{"Resources": ', 'not well-formed'),
        (template({}), 'At least one Resources member'),
        (template({'A': {'Type': 'AWS::S3::Bucket'}}), 'Unrecognized resource types: [AWS::S3::Bucket]'),
        (template({'A-1': param()}), 'non alphanumeric'),
        (template({'A': param(value={'Ref': 'Missing'})}), 'Unresolved resource dependencies [Missing]'),
        (template({'A': param(DependsOn='B'), 'B': param(DependsOn='A')}), 'Circular dependency'),
        (template({'A': param()}, Parameters={'Env': {'Type': 'String'}}), 'Parameters: [Env] must have values'),
    ])
    def test_invalid_templates(self, body, error):
        with pytest.raises(TemplateError, match=error.replace('[', r'\[').replace(']', r'\]')):
            parse(body)

    def test_unknown_parameter_rejected(self):
        with pytest.raises(TemplateError, match='do not exist'):
            parse(template({'A': param()}), Bogus='1')

    def test_references_ignore_sub_literals_and_local_variables(self):
        sub = {'Fn::Sub': ['${!Literal} ${Local} ${Res.Arn}', {'Local': {'Ref': 'Other'}}]}
        assert references(sub) == {'Res', 'Other'}


class TestProgressReporter:
    def test_emits_one_json_object_per_line_with_durations(self):
        out = io.StringIO()
        reporter = ProgressReporter(out)
        reporter.begin(Stage.PARSE, 'parsing')
        reporter.resource(Stage.PARSE, 'A', 'parsed', dependsOn=None)
        reporter.complete(Stage.PARSE_COMPLETE, Stage.PARSE, 'done')
        events = [json.loads(line) for line in out.getvalue().splitlines()]
        assert [e['stage'] for e in events] == ['PARSE', 'PARSE', 'PARSE_COMPLETE']
        assert events[1] == {**events[1], 'resource': 'A', 'status': 'parsed'} and 'dependsOn' not in events[1]
        assert events[2]['duration'] >= 0


class TestDeploymentIdentity:
    ROLE = 'arn:aws:iam::123456789012:role/cfn-service'
    BASE = {'stackName': 's', 'templateBody': '{}', 'account': '123456789012', 'region': 'eu-central-1'}

    def config(self, **extra):
        return DeployConfig.from_dict({**self.BASE, **extra})

    def test_role_arn_needs_issued_credentials(self):
        with pytest.raises(ValueError, match='roleArn needs the credentials'):
            self.config(roleArn=self.ROLE)

    def test_accepts_a_session_of_the_service_role(self):
        config = self.config(roleArn=self.ROLE, credentials={'accessKeyId': 'a', 'secretAccessKey': 'b'})
        verify_identity({'Account': '123456789012',
                         'Arn': 'arn:aws:sts::123456789012:assumed-role/cfn-service/AWSCloudFormation'}, config)

    @pytest.mark.parametrize('identity, code', [
        ({'Account': '123456789012', 'Arn': 'arn:aws:sts::123456789012:assumed-role/admin/x'}, 'RoleMismatch'),
        ({'Account': '123456789012', 'Arn': 'arn:aws:sts::123456789012:assumed-role/cfn-service-2/x'}, 'RoleMismatch'),
        ({'Account': '999999999999', 'Arn': 'arn:aws:sts::999999999999:assumed-role/cfn-service/x'}, 'AccountMismatch'),
    ])
    def test_rejects_other_identities(self, identity, code):
        config = self.config(roleArn=self.ROLE, credentials={'accessKeyId': 'a', 'secretAccessKey': 'b'})
        with pytest.raises(ApiError) as info:
            verify_identity(identity, config)
        assert info.value.code == code

    def test_without_role_any_identity_in_the_account(self):
        verify_identity({'Account': '123456789012', 'Arn': 'arn:aws:sts::123456789012:assumed-role/admin/x'},
                        self.config())


def _server_available() -> bool:
    try:
        ApiClient('eu-central-1').caller_identity()
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _server_available(), reason='simulator not running at localhost:3000')
class TestApiClientIntegration:
    def test_ssm_put_get_and_delete_parameter(self):
        api = ApiClient('eu-central-1')
        name, value = f'/cf-deploy-test/{uuid.uuid4()}', str(uuid.uuid4())
        api.call('ssm', 'PutParameter', Name=name, Value=value, Type='String')
        try:
            assert api.call('ssm', 'GetParameter', Name=name)['Parameter']['Value'] == value
        finally:
            api.call('ssm', 'DeleteParameter', Name=name)

    def test_errors_are_normalized(self):
        with pytest.raises(ApiError) as info:
            ApiClient('eu-central-1').call('ssm', 'GetParameter', Name=f'/does-not-exist/{uuid.uuid4()}')
        assert info.value.code == 'ParameterNotFound'
