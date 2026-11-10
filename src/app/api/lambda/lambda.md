# Lambda

Status: the control plane and `Invoke` as far as the walking skeleton needs (see [walking-skeleton.md](../../../../docs/walking-skeleton.md), step 4, and the plan in [lambda-plan.md](../../../../docs/lambda-plan.md)). The service is REST JSON (`lambda` credential scope; `proxy.ts` rewrites `/2015-03-31/functions/...` to `/api/lambda/...`), one route file per operation under `2015-03-31/`, `2017-03-31/`, `2019-09-30/`, `2020-06-30/`, `2024-08-31/` (the API versions of the paths). State is in `db/<account>/<region>/lambda.json`; the shared interfaces of VPC functions are in the EC2 state.

## What is there

| Operation | Notes |
| --- | --- |
| `CreateFunction` | Python only (`python3.9` to `python3.13`), `Code.ZipFile` only. Validates name, role (must exist and trust `lambda.amazonaws.com`), runtime, `Timeout` and `MemorySize` against the quota registry, reserved and oversized environment variables, zip size and format, `VpcConfig` (subnets and groups exist, same VPC; no group given means the default group of the VPC). Returns `Active` at once. |
| `GetFunction`, `GetFunctionConfiguration`, `ListFunctions`, `DeleteFunction` | By name, partial ARN or full ARN; only `$LATEST` exists, any other qualifier is `ResourceNotFoundException`. `ListFunctions` pages with `MaxItems` and `Marker`. |
| `Invoke` | `RequestResponse`, `Event` (answers 202 at once; the result is only in the invocation record), `DryRun`; `LogType=Tail`. See "Invocation". |
| `ListVersionsByFunction`, `GetFunctionCodeSigningConfig`, `GetFunctionRecursionConfig`, `GetFunctionConcurrency`, `ListTags` | Reads Terraform and the console make after every create. They answer for what exists: one version, no signing config, `Terminate`, no reserved concurrency, the tags. |

**Not there, rejected by name where a request can carry it:** `UpdateFunctionCode`, `UpdateFunctionConfiguration`, `PublishVersion`, aliases, layers, event source mappings, function URLs, permissions (`AddPermission`, `GetPolicy`), `TagResource`/`UntagResource`, concurrency settings, code from S3 or ECR, container images, other runtimes, `Publish`, dead-letter queues, file systems, KMS keys, SnapStart, tracing other than pass-through, ephemeral storage other than 512 MB, `ClientContext`. Terraform changes of an existing function need the update operations; creating and destroying are verified.

## Invocation

`invoke.ts` runs the handler through the runner of [walking-skeleton.md](../../../../docs/walking-skeleton.md) ("Step 3b"): a Python subprocess behind the network shim, with
- the **network position** of the function: for a VPC function the shared interface of its first subnet and its security groups (so routes, security groups and network ACLs of that subnet decide every connection, and the trace names the interface); without a VPC the AWS-managed network (public addresses reachable, private ones not);
- the **credentials of the execution role**, a session with the function name as session name (`arn:aws:sts::<account>:assumed-role/<role>/<function>`), through the same `issueSession` as `sts:AssumeRole`;
- the Lambda **environment** (`AWS_LAMBDA_FUNCTION_NAME`, `..._VERSION`, `..._MEMORY_SIZE`, `AWS_LAMBDA_LOG_GROUP_NAME`, `AWS_LAMBDA_LOG_STREAM_NAME`, `AWS_EXECUTION_ENV`, `_HANDLER`, `LAMBDA_TASK_ROOT`, `AWS_REGION`, the function's own variables) and a `context` object (`aws_request_id`, `function_name`, `invoked_function_arn`, `memory_limit_in_mb`, `get_remaining_time_in_millis()`, ...). `bootstrap.py` does what the Python runtime does around the handler (import errors as `Runtime.ImportModuleError`, a missing handler as `Runtime.HandlerNotFound`, exceptions with `errorType`, `errorMessage` and `stackTrace`, `Runtime.MarshalError`, the `[LEVEL] time request-id message` logging format).
- the **timeout on the virtual clock**: the function is stopped when its virtual time passes `Timeout`. Sleeping and waiting for a connect timeout count, so a call that retries for a minute takes the function down at 3 s as in AWS, in no real time. The response is `X-Amz-Function-Error: Unhandled` with `Task timed out after 3.00 seconds` (and the same line in the log).

The answer is AWS's: status 200 (the function error is in the `X-Amz-Function-Error` header, not the status), the payload, `X-Amz-Executed-Version`, `X-Amz-Log-Result` (the last 4 KB of the log, with the `START`, `END` and `REPORT` lines). What AWS does not give but this app is for: the connections the code made and the trace of each decision. They are kept per invocation (the last 10 per function, in `lambda.json`) and read with `GET /api/lambda/inspect?account=&region=&function=` (an internal, unsigned endpoint). `scripts/scenario/lambda.py` prints them after an invoke.

The Python that runs the code is the `python3` of this machine whatever `Runtime` says (set `JPK_PYTHON` to change it); the runtime name only shows up in `AWS_EXECUTION_ENV`. The runner resolves the real interpreter once (`sys.executable`), because `python3` is often a pyenv shim that costs about 0.6 s per start. An invocation that calls STS with boto3 takes about 0.4 s: roughly 0.3 s is Python, `import boto3` and creating the client (the same cold start the code would have), the rest is the call through the simulator. The `Duration` in the `REPORT` line is the handler only, as in AWS. There are no sleeps in the runner or the shim. The code of the function reaches the emulated services at `JPK_SIMULATOR_URL`, by default `http://localhost:$PORT` (3000).

## Resource lifetime

A function in a VPC owns no interface of its own: **one requester-managed interface per combination of subnet and set of security groups, shared by all functions with that combination** (`network.ts`; description `AWS Lambda VPC ENI-<function>-<uuid>`, `InterfaceType: lambda`). The interface is derived from the functions after every create and delete (`reconcileInterfaces`): it exists while a function wants it and goes with the last one. It takes one private address from the subnet (`AvailableIpAddressCount` shows it), blocks `DeleteSubnet` and `DeleteSecurityGroup` like any interface, and counts against the interface quota. A function with several subnets gets an interface in each; `Invoke` uses the first.

When the interface cannot be created (the subnet is full, the interface quota is reached) the function is created in the **`Failed` state** with `StateReasonCode` `SubnetOutOfIPAddresses` or `EniLimitExceeded` and the EC2 message in `StateReason`, and `Invoke` answers `ResourceConflictException`. This is the quota-style problem the app is meant to predict without real infrastructure.

Deleting a role a function uses is allowed (as in AWS): the next `Invoke` fails with `ServiceException`.

## Limits and quotas

From the registry ([quotas-plan.md](../../../../docs/quotas-plan.md)), all not adjustable: `lambda.function-timeout` (900 s), `lambda.function-memory-min` / `-max` (128 / 10,240 MB), `lambda.environment-variables-size` (4,096 bytes), `lambda.deployment-package-direct-size` (50 MB), `lambda.invocation-payload-synchronous` (6 MB). Not enforced, so not in the registry: concurrent executions, code storage, request rates.

## Not verified against real AWS

Written from the API reference and from memory; check against the documentation or a real account before relying on them:
- Error codes and messages: the `ValidationException` texts for name, role, timeout and memory (CreateFunction may answer `InvalidParameterValueException` for some), `Could not unzip uploaded file...`, the reserved-keys and 4 KB environment messages, the VPC messages (`Error occurred while DescribeSubnets. EC2 Error Code: ...`, "belong to different networks"), `Function already exist: <name>`, the cross-Region message, `RequestEntityTooLargeException` for a large zip, `InvalidRequestContentException` for a payload that is not JSON, `ResourceConflictException` for a Failed function.
- `State` is `Active` right after `CreateFunction`; AWS answers `Pending` and becomes `Active` after seconds (VPC functions longer), and `LastUpdateStatus` goes through `InProgress`.
- With no `SecurityGroupIds` the default group of the VPC is used.
- Several subnets: one interface each, `Invoke` using the first (AWS places environments by availability zone).
- One interface and one address per combination (AWS may create more under concurrency, and keeps interfaces for a while after the last function is gone).
- The `REPORT` line has no `Max Memory Used`; billed duration is the duration rounded up to the millisecond.
- A function without a VPC reaches every public address and no private one; AWS-managed addresses are not modelled.
- The sync payload limit is 6 MB (6,291,456 bytes); AWS reports a slightly different number.
- The `Code.Location` of `GetFunction` is a stand-in URL; there is no S3.
- Asynchronous invocations are not retried; their result is only in the invocation record.
- The Python log format of the root logger.
