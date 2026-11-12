import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'jpk-logs-'))
process.env.JPK_DB_ROOT = root

/* eslint-disable @typescript-eslint/no-require-imports */
const { logs } = require('@/app/api/logs/service')
const iam = require('@/app/api/data/iam')
const { QUOTAS, setQuota } = require('@/app/api/quotas')
const { loadLogs, readEvents } = require('@/app/api/data/logs')

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

describe('state and data', () => {
  const scope = { account, region }
  const dataDir = join(root, account, region, 'data', 'logs')
  const state = () => JSON.parse(readFileSync(join(root, account, region, 'logs.json'), 'utf8'))
  const read = (group: string, stream: string) => {
    const g = loadLogs(scope).groups[group]
    return readEvents(scope, g, g.streams[stream]).map((e: { message: string }) => e.message)
  }

  it('keep the events in the data directory, one JSON Lines file per stream, under names that can be read', async () => {
    await call('CreateLogGroup', { logGroupName: '/aws/lambda/split' })
    await call('CreateLogStream', { logGroupName: '/aws/lambda/split', logStreamName: '2026/11/10/[$LATEST]abc' })
    await call('PutLogEvents', { logGroupName: '/aws/lambda/split', logStreamName: '2026/11/10/[$LATEST]abc', logEvents: [{ timestamp: NOW, message: 'one' }, { timestamp: NOW + 1, message: 'two' }] })

    // /aws/lambda/split is the directory aws_lambda_split, and the stream a file in it
    expect(readdirSync(dataDir)).toContain('aws_lambda_split')
    expect(readdirSync(join(dataDir, 'aws_lambda_split'))).toEqual(['2026_11_10_LATEST_abc.jsonl'])
    const file = join(dataDir, 'aws_lambda_split', '2026_11_10_LATEST_abc.jsonl')
    expect(readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line).message)).toEqual(['one', 'two'])

    // the state has the real names, says where the data is, and holds no events
    const group = state().groups['/aws/lambda/split']
    expect(group).toMatchObject({ logGroupName: '/aws/lambda/split', dataDirectory: 'aws_lambda_split' })
    const stream = group.streams['2026/11/10/[$LATEST]abc']
    expect(stream).toMatchObject({ logStreamName: '2026/11/10/[$LATEST]abc', dataFile: '2026_11_10_LATEST_abc.jsonl', firstEventTimestamp: NOW, lastEventTimestamp: NOW + 1, storedBytes: 2 * 26 + 6 })
    expect(stream.events).toBeUndefined()
    expect(readFileSync(join(root, account, region, 'logs.json'), 'utf8')).not.toContain('"one"')
    expect(read('/aws/lambda/split', '2026/11/10/[$LATEST]abc')).toEqual(['one', 'two'])
  })

  it('append to the file, and read the events in the order of their timestamps', async () => {
    await call('CreateLogStream', { logGroupName: '/aws/lambda/split', logStreamName: 'late' })
    await call('PutLogEvents', { logGroupName: '/aws/lambda/split', logStreamName: 'late', logEvents: [{ timestamp: NOW, message: 'second batch, later event' }] })
    await call('PutLogEvents', { logGroupName: '/aws/lambda/split', logStreamName: 'late', logEvents: [{ timestamp: NOW - 100, message: 'earlier event, arrived later' }] })

    expect(readFileSync(join(dataDir, 'aws_lambda_split', 'late.jsonl'), 'utf8').trimEnd().split('\n')).toHaveLength(2)
    const events = (await call('GetLogEvents', { logGroupName: '/aws/lambda/split', logStreamName: 'late', startFromHead: true })).body.events
    expect(events.map((e: { message: string }) => e.message)).toEqual(['earlier event, arrived later', 'second batch, later event'])
    expect(state().groups['/aws/lambda/split'].streams.late).toMatchObject({ firstEventTimestamp: NOW - 100, lastEventTimestamp: NOW })
  })

  it('give names that differ only in what a file name cannot hold different files, also when only the case differs', async () => {
    await call('CreateLogGroup', { logGroupName: '/a/b' })
    await call('CreateLogGroup', { logGroupName: 'a_b' })
    await call('CreateLogGroup', { logGroupName: '/A/B' })
    expect(['/a/b', 'a_b', '/A/B'].map(name => state().groups[name].dataDirectory)).toEqual(['a_b', 'a_b-2', 'A_B-3'])

    await call('CreateLogStream', { logGroupName: '/a/b', logStreamName: 'x/y' })
    await call('CreateLogStream', { logGroupName: '/a/b', logStreamName: 'x_y' })
    await call('PutLogEvents', { logGroupName: '/a/b', logStreamName: 'x/y', logEvents: [{ timestamp: NOW, message: 'in x/y' }] })
    await call('PutLogEvents', { logGroupName: '/a/b', logStreamName: 'x_y', logEvents: [{ timestamp: NOW, message: 'in x_y' }] })
    expect(read('/a/b', 'x/y')).toEqual(['in x/y'])
    expect(read('/a/b', 'x_y')).toEqual(['in x_y'])
    expect(readdirSync(join(dataDir, 'a_b')).sort()).toEqual(['x_y-2.jsonl', 'x_y.jsonl'])
    for (const name of ['/a/b', 'a_b', '/A/B']) {
      await call('DeleteLogGroup', { logGroupName: name })
    }
  })

  it('go when the stream or the log group is deleted, and the name can be used again', async () => {
    await call('DeleteLogStream', { logGroupName: '/aws/lambda/split', logStreamName: 'late' })
    expect(existsSync(join(dataDir, 'aws_lambda_split', 'late.jsonl'))).toBe(false)
    expect(existsSync(join(dataDir, 'aws_lambda_split'))).toBe(true)
    await call('DeleteLogGroup', { logGroupName: '/aws/lambda/split' })
    expect(existsSync(join(dataDir, 'aws_lambda_split'))).toBe(false)

    await call('CreateLogGroup', { logGroupName: '/aws/lambda/split' })
    expect(state().groups['/aws/lambda/split'].dataDirectory).toBe('aws_lambda_split')
    await call('DeleteLogGroup', { logGroupName: '/aws/lambda/split' })
  })

  it('give a name from a state written before the data had files of their own, and drop the events it carried', () => {
    const old = state()
    old.groups['/legacy/group'] = { logGroupName: '/legacy/group', creationTime: 1, tags: {}, streams: { 'a/b': { logStreamName: 'a/b', creationTime: 1, events: [{ timestamp: 1, message: 'x', ingestionTime: 1 }] } } }
    writeFileSync(join(root, account, region, 'logs.json'), JSON.stringify(old))

    const loaded = loadLogs(scope).groups['/legacy/group']
    expect(loaded.dataDirectory).toBe('legacy_group')
    expect(loaded.streams['a/b']).toMatchObject({ dataFile: 'a_b.jsonl', storedBytes: 0 })
    expect(loaded.streams['a/b'].events).toBeUndefined()
  })
})

describe('names of files', () => {
  const { readableName, uniqueName, safeFileName } = require('@/app/api/data/store')

  it('are readable versions of the names they come from', () => {
    expect(readableName('/aws/lambda/orders-fn')).toBe('aws_lambda_orders-fn')
    expect(readableName('2026/11/10/[$LATEST]0341cc')).toBe('2026_11_10_LATEST_0341cc')
    expect(readableName('plain-name_1.v2')).toBe('plain-name_1.v2')
    expect(readableName('my group (prod)!')).toBe('my_group_prod')
  })

  it('can never be a path: no dot names, no separators, no empty name, bounded length', () => {
    expect(readableName('..')).toBe('_')
    expect(readableName('.')).toBe('_')
    expect(readableName('../../etc/passwd')).toBe('etc_passwd')
    expect(readableName('///')).toBe('_')
    expect(readableName('.hidden')).toBe('hidden')
    expect(readableName('a'.repeat(500))).toHaveLength(100)
  })

  it('are made different from the names that are taken', () => {
    expect(uniqueName('/a/b', [])).toBe('a_b')
    expect(uniqueName('/a/b', ['a_b'])).toBe('a_b-2')
    expect(uniqueName('/a/b', ['a_b', 'a_b-2'])).toBe('a_b-3')
    expect(uniqueName('/A/B', ['a_b'])).toBe('A_B-2')
    expect(uniqueName('x', ['x.jsonl'], '.jsonl')).toBe('x-2.jsonl')
    expect(uniqueName('x', [], '.jsonl')).toBe('x.jsonl')
  })

  it('are used as they are when the API already restricts the name, and refused otherwise', () => {
    expect(safeFileName('orders-fn')).toBe('orders-fn')
    expect(safeFileName('_internal_1')).toBe('_internal_1')
    for (const bad of ['', '.', '..', '../x', 'a/b', '.hidden']) {
      expect(() => safeFileName(bad)).toThrow(/cannot be used as a file name/)
    }
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
