# CloudFormation deployment engine

Python worker that deploys a CloudFormation template against the local simulator. The Next.js API spawns it and
streams its stdout to the UI.

Requires **Python ≥ 3.10** (the parser uses `match`) and `boto3` (`pip install -r requirements.txt`).
The macOS `/usr/bin/python3` is 3.9 and is refused with an `ERROR` event; use the pyenv interpreter.

```bash
python cf_deploy.py '{"stackName":"s","templateBody":"{...}","account":"123456789012","region":"eu-central-1"}'
python cf_deploy.py - < config.json     # config on stdin, for large templates
python -m pytest tests -q               # integration tests are skipped when localhost:3000 is down
```

Config fields: `stackName`, `templateBody`, `account`, `region`, optional `parameters` (mapping or
`[{ParameterKey, ParameterValue}]`), `endpointUrl` (default `$AWS_ENDPOINT_URL` or `http://localhost:3000`),
`credentials` (`{accessKeyId, secretAccessKey, sessionToken?}`, default: the boto3 credential chain), `roleArn`
(the stack's service role; requires `credentials`).

Credentials come from `deploymentSession()` in `src/app/api/cloudformation/role.ts`: the CloudFormation service checks
the role's trust and issues a session of it (or of the caller when the stack has no role). Before any API call the
engine checks with `sts:GetCallerIdentity` that it acts in the stack's account and, with `roleArn`, as a session of that
role. Every call after that is authorized against that identity's policies.

## Output

stdout carries only JSON lines, one event each; diagnostics go to stderr. Exit code 0 = success, 1 = template or
API error, 2 = invalid invocation.

```json
{"stage": "PARSE", "resource": "Param", "status": "parsed", "resourceType": "AWS::SSM::Parameter", "dependsOn": ["Role"], "timestamp": 1794552703.18}
{"stage": "PARSE_COMPLETE", "message": "Found 2 resources", "duration": 0.0, "order": ["Role", "Param"], "timestamp": 1794552703.18}
{"stage": "ERROR", "message": "...", "errorType": "ValidationError", "totalDuration": 0.2, "timestamp": 1794552703.19}
```

Stages: `START`, `PARSE`, `PARSE_COMPLETE`, `CONNECT`, `CONNECT_COMPLETE`, then (with the reconcilers) `COMPARE`,
`EXECUTE`, and finally `SUCCESS` or `ERROR`.

## Modules

| File | Role |
|------|------|
| `cf_deploy.py` | Entry point: read config, parse, verify identity, (reconcile), report |
| `cf_parser.py` | `TemplateParser` (intrinsics, from the project README) + `CloudFormationTemplate` (validation, conditions, dependencies, order) |
| `api_client.py` | boto3 clients against the simulator; requests must be SigV4-signed (see `src/proxy.ts`) |
| `progress_reporter.py` | JSON-line event writer |
| `reconcilers/__init__.py` | `Reconciler` interface: `create`, `diff` (None/Modify/Replace from old vs new template properties), `update` (a replacement creates the new resource and returns the old id for cleanup), `delete` (already gone = deleted) |
| `reconcilers/ssm.py` | `AWS::SSM::Parameter`: generated `CFN-<LogicalId>-<random>` name, `Name` change = replacement, `Ref` = name, `GetAtt` `Type`/`Value` |
| `cf_types.py` | `Resource`, `DeployConfig`, `Stage`, supported resource types (not `types.py`: that would shadow the stdlib) |
