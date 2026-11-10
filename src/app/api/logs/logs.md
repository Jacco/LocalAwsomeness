# CloudWatch Logs

Status: a minimal service, enough for the log of Lambda functions, `aws logs` and the SDKs. JSON 1.1, target `Logs_20140328` (`logs` credential scope; route `Logs_20140328/[action]`). It keeps **state** and **data** apart (see `src/app/api/db/store.ts`):

- **State**, `db/<account>/<region>/logs.json`: the log groups (retention, tags) and, per stream, only its metadata (creation time, timestamps of the first and last event, last ingestion, stored bytes), in the shape of the API.
- **Data**, `db/<account>/<region>/data/logs/<log group>/<log stream>.jsonl`: the events of a stream, one JSON object per line in the order they arrived (read back ordered by timestamp). Group and stream names are escaped to file names, so `/aws/lambda/fn` is the directory `%2Faws%2Flambda%2Ffn`. Deleting a stream or a group deletes its data.

## What is there

| Operation | Notes |
| --- | --- |
| `CreateLogGroup`, `DeleteLogGroup`, `DescribeLogGroups` | Name pattern and length as AWS; `ResourceAlreadyExistsException`; the log group quota of the account (`logs.log-groups-per-region`, `LimitExceededException`); tags at creation. `DescribeLogGroups` pages with `limit` (max 50) and `nextToken`, filters on `logGroupNamePrefix`, and returns the ARN with and without `:*`. |
| `CreateLogStream`, `DeleteLogStream`, `DescribeLogStreams` | Prefix, `orderBy` `LogStreamName` or `LastEventTime` (not with a prefix, as in AWS), `descending`, paging. |
| `PutLogEvents` | Chronological order within a batch, at most 10,000 events, 1 MB per batch (the size of an event is its UTF-8 bytes plus 26), 1,024 KB per event (all from the quota registry). Events older than 14 days or the retention, or more than 2 hours ahead, are not stored and reported in `rejectedLogEventsInfo`. Sequence tokens are accepted and ignored (AWS does not need them any more). |
| `GetLogEvents` | Newest `limit` events by default, `startFromHead`, `startTime` (inclusive) and `endTime` (exclusive), and the `f/<n>` and `b/<n>` tokens: the same token comes back when there is nothing more, which is how the CLI knows it has reached the end. |
| `FilterLogEvents` | Across the streams of a group (`logStreamNames` or `logStreamNamePrefix`), time range, paging. The filter pattern is **plain terms** that must all appear (case sensitive, quoted phrases); the JSON, space-delimited, `?`/`-` and regular expression syntaxes are rejected by name. |
| `PutRetentionPolicy`, `DeleteRetentionPolicy` | The values AWS accepts. Stored and reported, **not enforced**: events are never expired. |
| `ListTagsForResource`, `TagResource`, `UntagResource` | For log groups, by ARN. |

Not there: metric filters, subscription filters, destinations, export and import tasks, Insights queries, Live Tail (`aws logs tail --follow`; plain `tail` uses `FilterLogEvents`), data protection and transformers, KMS keys, other log group classes, the legacy `ListTagsLogGroup`. Parameters of the operations above that are not modelled are rejected by name.

## Permissions

Operations are authorized against the log group ARN (`arn:aws:logs:<region>:<account>:log-group:<name>`) or, for the stream operations (`CreateLogStream`, `DeleteLogStream`, `PutLogEvents`, `GetLogEvents`), the stream ARN (`...:log-group:<name>:log-stream:<stream>`); `DescribeLogGroups` against `log-group:*`. Denials are `AccessDeniedException` in the AWS wording (see [policy.md](../policy/policy.md)).

## Lambda writes its log here, with the execution role

`lambda/logging.ts`: after each invocation the log (`START`, the output, `END`, `REPORT`, one event per line) goes to the log group `/aws/lambda/<function>`, one stream per invocation (every invocation is a cold start in this model; stream name `yyyy/mm/dd/[$LATEST]<32 hex>`, also in `AWS_LAMBDA_LOG_STREAM_NAME`). As in AWS it is written **with the permissions of the execution role**, not the caller's: `logs:CreateLogGroup` (only when the group does not exist yet), `logs:CreateLogStream` and `logs:PutLogEvents`. A role without them gets **no log, and nobody is told**: not the function, not the caller of `Invoke`. The caller can still ask for the tail with `LogType=Tail`, which does not depend on CloudWatch.

Because that is exactly the question "why is there no log?", this app answers it where AWS does not: the invocation record (`data/lambda-invocations/<function>.json`, `GET /api/lambda/inspect`) has `LogDelivery` with the group, the stream, `written` or `not-written`, and for `not-written` the denial the role got. The log group stays when the function is deleted, as in AWS.

## Not verified against real AWS

- Status codes and exact messages of the errors (written from the API reference; all 400 here), `Resource limit exceeded.`, the `retentionInDays` error text, the `rejectedLogEventsInfo` indexes.
- Plain filter terms match as substrings; AWS matches terms on word boundaries.
- `storedBytes` of a group is derived (message bytes plus 26 per event) and always current; AWS reports it with a delay. Streams report 0, as AWS does today.
- The resource ARNs the actions are authorized against (the real mapping of each action to resource types, for example for `DescribeLogGroups`, is not checked).
- Lambda writes one stream per invocation; AWS reuses the stream of a warm execution environment, so several invocations share one.
- The timestamps of the Lambda log events: `START` and the output at the start of the invocation, `END` and `REPORT` at its end.
- The default log group name `/aws/lambda/<function>` and the logging configuration of a function (`LoggingConfig`) are fixed.

## Tests

`src/app/api/__tests__/logs.test.ts` (the operations, the limits, the tokens, filtering, permissions) and `lambda.test.ts` ("and its log in CloudWatch Logs": written with permission, silent without and the reason, no `CreateLogGroup` needed for an existing group, kept after the function is deleted). Verified with boto3 and the AWS CLI (`describe-log-groups`, `describe-log-streams`, `get-log-events`, `filter-log-events`) against the dev server, and with Terraform (`aws_cloudwatch_log_group` with retention and tags in `scripts/verify-lambda/main.tf`: apply, empty plan, destroy). By hand: `python3 scripts/scenario/lambda.py --revoke` (no log, with the reason), then `--invoke --logs`.
