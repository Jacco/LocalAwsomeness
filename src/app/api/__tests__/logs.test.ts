import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'jpk-logs-'))
process.env.JPK_DB_ROOT = root

/* eslint-disable @typescript-eslint/no-require-imports */
const { logs } = require('@/app/api/logs/service')
const iam = require('@/app/api/db/iam')
const { QUOTAS, setQuota } = require('@/app/api/quotas')

const account = '111111111111'
const region = 'eu-west-1'

beforeAll(() => mkdirSync(join(root, account), { recursive: true }))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const headers = (principal: string) => ({
  'x-aws-principal': principal,
  'x-aws-userid': 'AROAEXAMPLE',
  authorization: `AWS4-HMAC-SHA256 Credential=KEY/20250101/${region}/logs/aws4_request, SignedHeaders=host, Signature=abc`,
  'content-type': 'application/x-amz-json-1.1',
})
const ADMIN = `arn:aws:sts::${account}:assumed-role/admin/session`

interface Answer { status: number; body: any; type: string | null }

async function call(action: string, params: Record<string, unknown> = {}, principal = ADMIN): Promise<Answer> {
  const response: Response = await logs.postDynamic(
    new Request('http://localhost/api/logs', { method: 'POST', body: JSON.stringify(params), headers: { ...headers(principal), 'x-amz-target': `Logs_20140328.${action}` } }),
    { params: Promise.resolve({ action }) },
  )
  const body = await response.json()
  return { status: response.status, body, type: body.__type ?? response.headers.get('x-amzn-errortype') }
}
const failure = (answer: Answer) => ({ status: answer.status, type: answer.type, message: answer.body.message ?? answer.body.Message })

const NOW = Date.now()

describe('log groups', () => {
  it('are created, described with their ARNs and deleted', async () => {
    expect((await call('CreateLogGroup', { logGroupName: '/app/web', tags: { team: 'a' } })).status).toBe(200)
    expect((await call('CreateLogGroup', { logGroupName: '/app/api' })).status).toBe(200)

    const described = (await call('DescribeLogGroups')).body.logGroups
    expect(described.map((g: any) => g.logGroupName)).toEqual(['/app/api', '/app/web'])
    expect(described[1]).toMatchObject({
      logGroupName: '/app/web', metricFilterCount: 0, storedBytes: 0, logGroupClass: 'STANDARD',
      arn: `arn:aws:logs:${region}:${account}:log-group:/app/web:*`, logGroupArn: `arn:aws:logs:${region}:${account}:log-group:/app/web`,
    })
    expect(described[1].creationTime).toBeGreaterThan(NOW - 1000)
    expect((await call('DescribeLogGroups', { logGroupNamePrefix: '/app/w' })).body.logGroups).toHaveLength(1)

    const page = (await call('DescribeLogGroups', { limit: 1 })).body
    expect(page.logGroups).toHaveLength(1)
    expect((await call('DescribeLogGroups', { limit: 1, nextToken: page.nextToken })).body.logGroups[0].logGroupName).toBe('/app/web')

    expect((await call('DeleteLogGroup', { logGroupName: '/app/api' })).status).toBe(200)
    expect(failure(await call('DeleteLogGroup', { logGroupName: '/app/api' }))).toEqual({ status: 400, type: 'ResourceNotFoundException', message: 'The specified log group does not exist.' })
    await call('DeleteLogGroup', { logGroupName: '/app/web' })
  })

  it('refuse a name that exists, a bad name, and what is not modelled', async () => {
    await call('CreateLogGroup', { logGroupName: 'dup' })
    expect(failure(await call('CreateLogGroup', { logGroupName: 'dup' }))).toEqual({ status: 400, type: 'ResourceAlreadyExistsException', message: 'The specified log group already exists' })
    expect(failure(await call('CreateLogGroup', { logGroupName: 'bad name!' })).message).toMatch(/Value 'bad name!' at 'logGroupName'/)
    expect(failure(await call('CreateLogGroup', { logGroupName: 'k', kmsKeyId: 'arn:aws:kms:x' })).message).toBe("Parameter 'kmsKeyId' is not supported by this simulator yet")
    expect(failure(await call('CreateLogGroup', { logGroupName: 'k', logGroupClass: 'INFREQUENT_ACCESS' })).message).toMatch(/only STANDARD/)
    expect(failure(await call('DescribeLogGroups', { logGroupNamePattern: 'x' })).message).toMatch(/'logGroupNamePattern' is not supported/)
    await call('DeleteLogGroup', { logGroupName: 'dup' })
  })

  it('are limited per Region by the quota of the account', async () => {
    setQuota({ account, region }, QUOTAS.logGroupsPerRegion, 2)
    await call('CreateLogGroup', { logGroupName: 'q1' })
    await call('CreateLogGroup', { logGroupName: 'q2' })
    expect(failure(await call('CreateLogGroup', { logGroupName: 'q3' }))).toEqual({ status: 400, type: 'LimitExceededException', message: 'Resource limit exceeded.' })
    setQuota({ account, region }, QUOTAS.logGroupsPerRegion, 1000000)
    await call('DeleteLogGroup', { logGroupName: 'q1' })
    await call('DeleteLogGroup', { logGroupName: 'q2' })
  })

  it('keep a retention policy and tags', async () => {
    await call('CreateLogGroup', { logGroupName: 'kept', tags: { a: '1' } })
    const arn = `arn:aws:logs:${region}:${account}:log-group:kept`
    expect((await call('PutRetentionPolicy', { logGroupName: 'kept', retentionInDays: 7 })).status).toBe(200)
    expect((await call('DescribeLogGroups', { logGroupNamePrefix: 'kept' })).body.logGroups[0].retentionInDays).toBe(7)
    expect(failure(await call('PutRetentionPolicy', { logGroupName: 'kept', retentionInDays: 8 })).type).toBe('InvalidParameterException')
    await call('DeleteRetentionPolicy', { logGroupName: 'kept' })
    expect((await call('DescribeLogGroups', { logGroupNamePrefix: 'kept' })).body.logGroups[0].retentionInDays).toBeUndefined()

    expect((await call('ListTagsForResource', { resourceArn: `${arn}:*` })).body.tags).toEqual({ a: '1' })
    await call('TagResource', { resourceArn: arn, tags: { b: '2' } })
    await call('UntagResource', { resourceArn: arn, tagKeys: ['a'] })
    expect((await call('ListTagsForResource', { resourceArn: arn })).body.tags).toEqual({ b: '2' })
    expect(failure(await call('ListTagsForResource', { resourceArn: `${arn}-nope` })).type).toBe('ResourceNotFoundException')
    await call('DeleteLogGroup', { logGroupName: 'kept' })
  })
})

describe('log streams and events', () => {
  const group = 'events'
  const batch = (n: number, start = NOW - 10000) => Array.from({ length: n }, (_, i) => ({ timestamp: start + i, message: `line ${i}` }))

  beforeAll(async () => {
    await call('CreateLogGroup', { logGroupName: group })
  })

  it('are created, listed and deleted', async () => {
    expect((await call('CreateLogStream', { logGroupName: group, logStreamName: 'b' })).status).toBe(200)
    await call('CreateLogStream', { logGroupName: group, logStreamName: 'a' })
    expect(failure(await call('CreateLogStream', { logGroupName: group, logStreamName: 'a' }))).toEqual({ status: 400, type: 'ResourceAlreadyExistsException', message: 'The specified log stream already exists' })
    expect(failure(await call('CreateLogStream', { logGroupName: 'nope', logStreamName: 'a' })).type).toBe('ResourceNotFoundException')
    expect(failure(await call('CreateLogStream', { logGroupName: group, logStreamName: 'a:b' })).message).toMatch(/logStreamName/)

    const streams = (await call('DescribeLogStreams', { logGroupName: group })).body.logStreams
    expect(streams.map((s: any) => s.logStreamName)).toEqual(['a', 'b'])
    expect(streams[0]).toMatchObject({ arn: `arn:aws:logs:${region}:${account}:log-group:${group}:log-stream:a`, storedBytes: 0 })
    expect(streams[0].firstEventTimestamp).toBeUndefined()
    expect((await call('DescribeLogStreams', { logGroupName: group, logStreamNamePrefix: 'b' })).body.logStreams).toHaveLength(1)
    expect((await call('DescribeLogStreams', { logGroupName: group, descending: true })).body.logStreams[0].logStreamName).toBe('b')
    expect(failure(await call('DescribeLogStreams', { logGroupName: group, orderBy: 'LastEventTime', logStreamNamePrefix: 'a' })).message).toBe('Cannot order by LastEventTime with a logStreamNamePrefix.')

    expect((await call('DeleteLogStream', { logGroupName: group, logStreamName: 'b' })).status).toBe(200)
    expect(failure(await call('DeleteLogStream', { logGroupName: group, logStreamName: 'b' })).message).toBe('The specified log stream does not exist.')
  })

  it('take events and give them back in order with the tokens of AWS', async () => {
    await call('CreateLogStream', { logGroupName: group, logStreamName: 'read' })
    expect((await call('PutLogEvents', { logGroupName: group, logStreamName: 'read', logEvents: batch(5) })).body).toEqual({})

    const stream = (await call('DescribeLogStreams', { logGroupName: group, logStreamNamePrefix: 'read' })).body.logStreams[0]
    expect(stream).toMatchObject({ firstEventTimestamp: NOW - 10000, lastEventTimestamp: NOW - 10000 + 4 })
    expect((await call('DescribeLogGroups', { logGroupNamePrefix: group })).body.logGroups[0].storedBytes).toBeGreaterThan(0)

    // the newest events by default, in order
    const latest = (await call('GetLogEvents', { logGroupName: group, logStreamName: 'read', limit: 2 })).body
    expect(latest.events.map((e: any) => e.message)).toEqual(['line 3', 'line 4'])
    expect(latest.events[0].ingestionTime).toBeGreaterThanOrEqual(NOW)
    // from the start, then on with the forward token, then nothing more and the same token back
    const head = (await call('GetLogEvents', { logGroupName: group, logStreamName: 'read', limit: 2, startFromHead: true })).body
    expect(head.events.map((e: any) => e.message)).toEqual(['line 0', 'line 1'])
    const next = (await call('GetLogEvents', { logGroupName: group, logStreamName: 'read', limit: 10, nextToken: head.nextForwardToken })).body
    expect(next.events.map((e: any) => e.message)).toEqual(['line 2', 'line 3', 'line 4'])
    const end = (await call('GetLogEvents', { logGroupName: group, logStreamName: 'read', nextToken: next.nextForwardToken })).body
    expect(end.events).toEqual([])
    expect(end.nextForwardToken).toBe(next.nextForwardToken)
    // and back with the backward token
    const back = (await call('GetLogEvents', { logGroupName: group, logStreamName: 'read', limit: 2, nextToken: latest.nextBackwardToken })).body
    expect(back.events.map((e: any) => e.message)).toEqual(['line 1', 'line 2'])
    // a time range: start inclusive, end exclusive
    const range = (await call('GetLogEvents', { logGroupName: group, logStreamName: 'read', startTime: NOW - 10000 + 1, endTime: NOW - 10000 + 3, startFromHead: true })).body
    expect(range.events.map((e: any) => e.message)).toEqual(['line 1', 'line 2'])
    expect(failure(await call('GetLogEvents', { logGroupName: group, logStreamName: 'nope' })).message).toBe('The specified log stream does not exist.')
    expect(failure(await call('GetLogEvents', { logGroupName: group, logStreamName: 'read', nextToken: 'junk' })).type).toBe('InvalidParameterException')
  })

  it('refuse events out of order, too big, too many or none, and report events too old or too new', async () => {
    await call('CreateLogStream', { logGroupName: group, logStreamName: 'rules' })
    const put = (logEvents: unknown) => call('PutLogEvents', { logGroupName: group, logStreamName: 'rules', logEvents })

    expect(failure(await put([{ timestamp: NOW, message: 'b' }, { timestamp: NOW - 5, message: 'a' }])).message).toBe('Log events in a single PutLogEvents request must be in chronological order.')
    expect(failure(await put([])).type).toBe('InvalidParameterException')
    expect(failure(await put(batch(10001))).message).toMatch(/less than or equal to 10000/)
    expect(failure(await put([{ timestamp: NOW, message: 'x'.repeat(1048576) }])).message).toMatch(/Log event too large/)
    expect(failure(await put([{ timestamp: NOW, message: 'x'.repeat(600000) }, { timestamp: NOW, message: 'y'.repeat(600000) }])).message).toMatch(/Batch too large/)
    expect(failure(await call('PutLogEvents', { logGroupName: group, logStreamName: 'nope', logEvents: batch(1) })).message).toBe('The specified log stream does not exist.')

    const old = NOW - 15 * 24 * 3600 * 1000
    const future = NOW + 3 * 3600 * 1000
    const rejected = (await put([{ timestamp: old, message: 'old' }, { timestamp: NOW, message: 'now' }, { timestamp: future, message: 'future' }])).body
    expect(rejected).toEqual({ rejectedLogEventsInfo: { tooOldLogEventEndIndex: 1, tooNewLogEventStartIndex: 2 } })
    expect((await call('GetLogEvents', { logGroupName: group, logStreamName: 'rules' })).body.events.map((e: any) => e.message)).toEqual(['now'])
  })

  it('are searched across streams with plain terms', async () => {
    await call('CreateLogStream', { logGroupName: group, logStreamName: 'f1' })
    await call('CreateLogStream', { logGroupName: group, logStreamName: 'f2' })
    const t = NOW - 5000
    await call('PutLogEvents', { logGroupName: group, logStreamName: 'f1', logEvents: [{ timestamp: t, message: 'ERROR disk full' }, { timestamp: t + 20, message: 'INFO ok' }] })
    await call('PutLogEvents', { logGroupName: group, logStreamName: 'f2', logEvents: [{ timestamp: t + 10, message: 'ERROR network down' }] })
    const filter = (params: Record<string, unknown>) => call('FilterLogEvents', { logGroupName: group, logStreamNamePrefix: 'f', ...params })

    const errors = (await filter({ filterPattern: 'ERROR' })).body
    expect(errors.events.map((e: any) => [e.logStreamName, e.message])).toEqual([['f1', 'ERROR disk full'], ['f2', 'ERROR network down']])
    expect(errors.searchedLogStreams).toEqual([{ logStreamName: 'f1', searchedCompletely: true }, { logStreamName: 'f2', searchedCompletely: true }])
    expect((await filter({ filterPattern: 'ERROR disk' })).body.events).toHaveLength(1)
    expect((await filter({ filterPattern: '"network down"' })).body.events).toHaveLength(1)
    expect((await filter({})).body.events.map((e: any) => e.message)).toEqual(['ERROR disk full', 'ERROR network down', 'INFO ok'])
    expect((await filter({ logStreamNames: ['f2'], logStreamNamePrefix: undefined })).body.events).toHaveLength(1)
    expect((await filter({ startTime: t + 5, endTime: t + 15 })).body.events.map((e: any) => e.message)).toEqual(['ERROR network down'])
    const page = (await filter({ limit: 2 })).body
    expect(page.events).toHaveLength(2)
    expect((await filter({ limit: 2, nextToken: page.nextToken })).body.events.map((e: any) => e.message)).toEqual(['INFO ok'])
    expect(failure(await filter({ filterPattern: '{ $.level = "ERROR" }' })).message).toMatch(/filter syntax that is not supported/)
  })
})

describe('permissions on logs', () => {
  it('are checked against the log group and log stream a call names', async () => {
    iam.createRole(account, { roleName: 'writer', assumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] } })
    const writer = `arn:aws:sts::${account}:assumed-role/writer/session`
    iam.putRolePolicy(account, 'writer', 'only-mine', {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: `arn:aws:logs:${region}:${account}:log-group:/mine*` }],
    })
    expect((await call('CreateLogGroup', { logGroupName: '/mine' }, writer)).status).toBe(200)
    expect((await call('CreateLogStream', { logGroupName: '/mine', logStreamName: 's' }, writer)).status).toBe(200)
    expect((await call('PutLogEvents', { logGroupName: '/mine', logStreamName: 's', logEvents: [{ timestamp: NOW, message: 'm' }] }, writer)).status).toBe(200)

    const denied = await call('CreateLogGroup', { logGroupName: '/other' }, writer)
    expect(failure(denied)).toEqual({
      status: 403, type: 'AccessDeniedException',
      message: `User: ${writer} is not authorized to perform: logs:CreateLogGroup on resource: arn:aws:logs:${region}:${account}:log-group:/other because no identity-based policy allows the logs:CreateLogGroup action`,
    })
    // reading was not granted
    expect(failure(await call('GetLogEvents', { logGroupName: '/mine', logStreamName: 's' }, writer)).type).toBe('AccessDeniedException')
    expect(failure(await call('DescribeLogGroups', {}, writer)).message).toMatch(/not authorized to perform: logs:DescribeLogGroups/)
  })
})
