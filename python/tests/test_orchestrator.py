import io
import json
import os
import sys
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from api_client import ApiClient, ApiError  # noqa: E402
from cf_parser import CloudFormationTemplate, TemplateContext  # noqa: E402
from cf_types import ResourceState  # noqa: E402
from orchestrator import DeploymentFailed, Orchestrator  # noqa: E402
from progress_reporter import ProgressReporter  # noqa: E402


class FakeSsm:
    """In-memory SSM with the behaviour the reconciler relies on; `fail_on` names make PutParameter fail."""

    def __init__(self, fail_on=()):
        self.parameters: dict[str, dict] = {}
        self.fail_on = set(fail_on)

    def call(self, service, operation, **p):
        assert service == 'ssm'
        if operation == 'PutParameter':
            if p['Name'] in self.fail_on:
                raise ApiError('ssm', operation, 'AccessDeniedException', f'not allowed on {p["Name"]}')
            if p['Name'] in self.parameters and not p.get('Overwrite'):
                raise ApiError('ssm', operation, 'ParameterAlreadyExists', 'The parameter already exists.')
            self.parameters[p['Name']] = {'Value': p['Value'], 'Type': p['Type']}
            return {}
        if operation == 'DeleteParameter':
            if p['Name'] not in self.parameters:
                raise ApiError('ssm', operation, 'ParameterNotFound', 'not found')
            del self.parameters[p['Name']]
            return {}
        raise AssertionError(operation)


def param(name, value, **extra):
    return {'Type': 'AWS::SSM::Parameter', 'Properties': {'Name': name, 'Type': 'String', 'Value': value}, **extra}


def run(api, resources, previous=None, operation='CREATE', disable_rollback=False):
    out = io.StringIO()
    template = CloudFormationTemplate(json.dumps({'Resources': resources}),
                                      TemplateContext(account='123456789012', region='eu-central-1', stack_name='s'))
    template.parse()
    orchestrator = Orchestrator(api, ProgressReporter(out), 's', disable_rollback)
    try:
        state = orchestrator.deploy(template, previous or {}, operation)
        error = None
    except DeploymentFailed as e:
        state, error = e.resources, e
    events = [json.loads(line) for line in out.getvalue().splitlines()]
    return state, error, [(e['resource'], e['status']) for e in events if 'resource' in e]


A = param('/a', '1')
B_REF_A = param('/b', {'Fn::Sub': 'from-${A}'})


class TestCreateAndUpdate:
    def test_creates_in_dependency_order_and_resolves_refs(self):
        api = FakeSsm()
        state, error, events = run(api, {'B': B_REF_A, 'A': A})
        assert error is None
        assert api.parameters == {'/a': {'Value': '1', 'Type': 'String'}, '/b': {'Value': 'from-/a', 'Type': 'String'}}
        assert list(state) == ['A', 'B'] and state['B'].physical_id == '/b'
        assert events == [('A', 'CREATE_IN_PROGRESS'), ('A', 'CREATE_COMPLETE'),
                          ('B', 'CREATE_IN_PROGRESS'), ('B', 'CREATE_COMPLETE')]

    def test_unchanged_resources_make_no_calls(self):
        api = FakeSsm()
        state, _, _ = run(api, {'A': A, 'B': B_REF_A})
        api.call = lambda *a, **k: pytest.fail('no API call expected')
        again, error, events = run(api, {'A': A, 'B': B_REF_A}, state, 'UPDATE')
        assert error is None and events == [('A', 'UPDATE_COMPLETE'), ('B', 'UPDATE_COMPLETE')]

    def test_replacement_updates_dependents_and_cleans_up_afterwards(self):
        api = FakeSsm()
        state, _, _ = run(api, {'A': A, 'B': B_REF_A})
        state, error, events = run(api, {'A': param('/a2', '1'), 'B': B_REF_A}, state, 'UPDATE')
        assert error is None
        assert api.parameters == {'/a2': {'Value': '1', 'Type': 'String'}, '/b': {'Value': 'from-/a2', 'Type': 'String'}}
        assert events == [('A', 'UPDATE_IN_PROGRESS'), ('A', 'UPDATE_COMPLETE'),
                          ('B', 'UPDATE_IN_PROGRESS'), ('B', 'UPDATE_COMPLETE'),
                          ('A', 'DELETE_IN_PROGRESS'), ('A', 'DELETE_COMPLETE')]
        assert state['A'].physical_id == '/a2'

    def test_removed_resources_are_deleted_unless_retained(self):
        api = FakeSsm()
        state, _, _ = run(api, {'A': A, 'B': param('/b', 'x'), 'C': param('/c', 'y', DeletionPolicy='Retain')})
        state, error, events = run(api, {'A': A}, state, 'UPDATE')
        assert error is None and list(state) == ['A']
        assert set(api.parameters) == {'/a', '/c'}
        assert ('C', 'DELETE_SKIPPED') in events and ('B', 'DELETE_COMPLETE') in events


class TestFailures:
    def test_failed_create_rolls_back_what_was_created(self):
        api = FakeSsm(fail_on={'/b'})
        state, error, events = run(api, {'A': A, 'B': param('/b', 'x')})
        assert error.stack_status == 'ROLLBACK_COMPLETE' and state == {}
        assert api.parameters == {}
        assert ('B', 'CREATE_FAILED') in events and events[-2:] == [('A', 'DELETE_IN_PROGRESS'), ('A', 'DELETE_COMPLETE')]
        assert 'AccessDeniedException' in str(error)

    def test_failed_update_restores_the_previous_state(self):
        api = FakeSsm()
        previous, _, _ = run(api, {'A': A, 'B': param('/b', 'x')})
        api.fail_on = {'/c'}
        state, error, events = run(api, {'A': param('/a', '2'), 'B': param('/b', 'x'), 'C': param('/c', 'z')},
                                   previous, 'UPDATE')
        assert error.stack_status == 'UPDATE_ROLLBACK_COMPLETE'
        assert api.parameters['/a']['Value'] == '1' and '/c' not in api.parameters
        assert state is previous

    def test_disable_rollback_keeps_what_was_done(self):
        api = FakeSsm(fail_on={'/b'})
        state, error, events = run(api, {'A': A, 'B': param('/b', 'x')}, disable_rollback=True)
        assert error.stack_status == 'CREATE_FAILED' and list(state) == ['A'] and '/a' in api.parameters

    def test_creating_an_existing_parameter_fails_without_touching_it(self):
        api = FakeSsm()
        api.parameters['/a'] = {'Value': 'theirs', 'Type': 'String'}
        _, error, _ = run(api, {'A': A})
        assert 'ParameterAlreadyExists' in str(error) and api.parameters['/a']['Value'] == 'theirs'


class TestDelete:
    def test_deletes_in_reverse_order_and_skips_retained(self):
        api = FakeSsm()
        state, _, _ = run(api, {'A': A, 'B': B_REF_A, 'C': param('/c', 'y', DeletionPolicy='Retain')})
        out = io.StringIO()
        assert Orchestrator(api, ProgressReporter(out), 's').delete(state) == {}
        statuses = [(e['resource'], e['status']) for e in map(json.loads, out.getvalue().splitlines()) if 'resource' in e]
        assert list(state) == ['A', 'C', 'B']  # deployment order: A and C have no dependencies
        assert statuses == [('B', 'DELETE_IN_PROGRESS'), ('B', 'DELETE_COMPLETE'), ('C', 'DELETE_SKIPPED'),
                            ('A', 'DELETE_IN_PROGRESS'), ('A', 'DELETE_COMPLETE')]
        assert set(api.parameters) == {'/c'}

    def test_unsupported_type_is_rejected_before_anything_happens(self):
        api = FakeSsm()
        with pytest.raises(Exception, match='not supported by the deployment engine yet'):
            run(api, {'A': A, 'R': {'Type': 'AWS::IAM::Role', 'Properties': {}}})
        assert api.parameters == {}


def _server_available() -> bool:
    try:
        ApiClient('eu-central-1').caller_identity()
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _server_available(), reason='simulator not running at localhost:3000')
def test_cf_deploy_create_update_delete_against_the_simulator():
    import subprocess
    script = os.path.join(os.path.dirname(__file__), '..', 'cf_deploy.py')
    prefix = f'/cf-deploy-test/{uuid.uuid4()}'

    def deploy(operation, resources=None, previous=None):
        config = {'stackName': 'orchestrator-test', 'account': '123456789012', 'region': 'eu-central-1',
                  'operation': operation, 'previousResources': previous or {}}
        if resources:
            config['templateBody'] = json.dumps({'Resources': resources})
        out = subprocess.run([sys.executable, script, '-'], input=json.dumps(config), capture_output=True, text=True)
        final = json.loads(out.stdout.splitlines()[-1])
        assert final['stage'] == 'SUCCESS', final
        return final['resources']

    api = ApiClient('eu-central-1')
    resources = deploy('CREATE', {'A': param(f'{prefix}/a', '1'), 'B': param(f'{prefix}/b', {'Fn::GetAtt': ['A', 'Value']})})
    assert api.call('ssm', 'GetParameter', Name=f'{prefix}/b')['Parameter']['Value'] == '1'
    resources = deploy('UPDATE', {'A': param(f'{prefix}/a', '2'), 'B': param(f'{prefix}/b', {'Fn::GetAtt': ['A', 'Value']})},
                       resources)
    assert api.call('ssm', 'GetParameter', Name=f'{prefix}/b')['Parameter']['Value'] == '2'
    assert deploy('DELETE', previous=resources) == {}
    with pytest.raises(ApiError, match='ParameterNotFound'):
        api.call('ssm', 'GetParameter', Name=f'{prefix}/a')
