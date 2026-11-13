#!/usr/bin/env python3
"""CloudFormation deployment engine entry point.

Usage:
    cf_deploy.py '<config json>'
    cf_deploy.py - < config.json          (or no argument: config on stdin; use this for large templates)

Config: {"stackName", "templateBody", "account", "region", "parameters"?, "endpointUrl"?, "credentials"?, "roleArn"?}

stdout carries only JSON-line progress events (see progress_reporter.py); diagnostics go to stderr.
Exit codes: 0 success, 1 deployment/template error, 2 invalid invocation.
"""
import json
import sys

if sys.version_info < (3, 10):
    # cf_parser uses `match`; fail with an event instead of a SyntaxError on import.
    print(json.dumps({'stage': 'ERROR', 'message': f'Python >= 3.10 required, got {sys.version.split()[0]}',
                      'errorType': 'EnvironmentError'}), flush=True)
    sys.exit(2)

import traceback
from typing import Any

from api_client import ApiClient, ApiError
from cf_parser import CloudFormationTemplate, TemplateContext
from cf_types import DeployConfig, Stage, TemplateError
from progress_reporter import ProgressReporter

def read_config(argv: list[str]) -> DeployConfig:
    raw = argv[1] if len(argv) > 1 and argv[1] != '-' else sys.stdin.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f'Config is not valid JSON: {e}') from e
    if not isinstance(data, dict):
        raise ValueError('Config must be a JSON object')
    return DeployConfig.from_dict(data)


def parse(config: DeployConfig, reporter: ProgressReporter) -> CloudFormationTemplate:
    reporter.begin(Stage.PARSE, 'Parsing CloudFormation template...')
    context = TemplateContext(
        account=config.account, region=config.region, stack_name=config.stack_name, parameters=config.parameters)
    template = CloudFormationTemplate(config.template_body, context)
    resources = template.parse()
    for resource in resources:
        reporter.resource(Stage.PARSE, resource.logical_id, 'parsed', resourceType=resource.type,
                          dependsOn=sorted(resource.depends_on) or None)
    for logical_id in template.skipped:
        reporter.resource(Stage.PARSE, logical_id, 'skipped', reason='Condition is false')
    reporter.complete(Stage.PARSE_COMPLETE, Stage.PARSE, f'Found {len(resources)} resources',
                      resourceCount=len(resources), order=template.order)
    return template


def verify_identity(identity: dict[str, Any], config: DeployConfig) -> None:
    """The deployment must act in the stack's account and, with a service role, as a session of that role."""
    arn = identity.get('Arn', '')
    if identity.get('Account') != config.account:
        raise ApiError('sts', 'GetCallerIdentity', 'AccountMismatch',
                       f'Credentials belong to account {identity.get("Account")}, stack is in {config.account}')
    if config.role_arn:
        role_name = config.role_arn.rsplit('/', 1)[-1]
        role_account = config.role_arn.split(':')[4]
        if not arn.startswith(f'arn:aws:sts::{role_account}:assumed-role/{role_name}/'):
            raise ApiError('sts', 'GetCallerIdentity', 'RoleMismatch',
                           f'Credentials are for {arn}, not a session of the service role {config.role_arn}')


def connect(config: DeployConfig, reporter: ProgressReporter) -> ApiClient:
    """Switch to the deployment credentials before any API call; every later call is authorized as that identity."""
    api = ApiClient(config.region, config.endpoint_url, config.credentials)
    reporter.begin(Stage.CONNECT, f'Connecting to {api.endpoint_url}...')
    identity = api.caller_identity()  # needs no permission
    verify_identity(identity, config)
    acting_as = f'service role {config.role_arn}' if config.role_arn else 'the caller (no service role)'
    reporter.complete(Stage.CONNECT_COMPLETE, Stage.CONNECT, f'Acting as {identity.get("Arn")}, {acting_as}',
                      principal=identity.get('Arn'), roleArn=config.role_arn)
    return api


def main(argv: list[str]) -> int:
    reporter = ProgressReporter()
    try:
        config = read_config(argv)
    except (ValueError, KeyError, TypeError) as e:
        reporter.error(str(e), errorType='InvalidConfig')
        return 2

    reporter.report(Stage.START, f'Deploying stack {config.stack_name}', stackName=config.stack_name,
                    account=config.account, region=config.region)
    try:
        template = parse(config, reporter)
        connect(config, reporter)
        # Reconciliation (COMPARE/EXECUTE) is added by the per-service reconcilers (task 4.1b.2+).
        reporter.success(f'Stack {config.stack_name}: template parsed, credentials verified',
                         resourceCount=len(template.resources))
        return 0
    except TemplateError as e:
        reporter.error(str(e), errorType='ValidationError')
    except ApiError as e:
        reporter.error(str(e), errorType=e.code, service=e.service, operation=e.operation)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        reporter.error(f'Internal error: {e}', errorType=type(e).__name__)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
