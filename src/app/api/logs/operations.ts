import { AwsError } from "../common"
import {
  appendEvents, createGroup, createStream, eventSize, loadLogs, logGroupArn, logStreamArn, readEvents, removeGroupData, removeStreamData,
  saveLogs, storedBytes, type LogEvent, type LogGroup, type LogStream, type LogsState,
} from '../data/logs'
import { QUOTAS, hardLimit, quota } from "../quotas"
import type { RequestContext } from "../registry"

// CloudWatch Logs as far as `aws logs tail`, the SDKs and Lambda need it: log groups, streams, putting and reading events,
// retention (stored, not enforced) and tags. Parameters that are not modelled are rejected by name. Behaviour that is from
// memory of AWS and not verified is listed in logs.md.

const GROUP_NAME = /^[.\-_/#A-Za-z0-9]+$/
const STREAM_NAME = /^[^:*]+$/
// The values AWS accepts for retentionInDays.
const RETENTION = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653]
const TWO_HOURS = 2 * 60 * 60 * 1000
const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000
const MAX_READ = 10000

const invalid = (message: string) => new AwsError('InvalidParameterException', message, 400)
const noGroup = () => new AwsError('ResourceNotFoundException', 'The specified log group does not exist.', 400)
const noStream = () => new AwsError('ResourceNotFoundException', 'The specified log stream does not exist.', 400)
const present = (value: unknown) => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)

function refuse(params: Record<string, unknown>, members: string[]) {
  for (const member of members) {
    if (present(params[member])) {
      throw invalid(`Parameter '${member}' is not supported by this simulator yet`)
    }
  }
}

function validateName(value: unknown, member: string, pattern: RegExp): string {
  if (typeof value !== 'string' || value === '') {
    throw invalid(`1 validation error detected: Value null at '${member}' failed to satisfy constraint: Member must not be null`)
  }
  if (value.length > 512 || !pattern.test(value)) {
    throw invalid(`1 validation error detected: Value '${value}' at '${member}' failed to satisfy constraint: Member must satisfy regular expression pattern: ${pattern.source.replace(/^\^|\$$/g, '')}`)
  }
  return value
}

function pageSize(limit: unknown, max: number, dflt: number): number {
  if (limit === undefined) {
    return dflt
  }
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > max) {
    throw invalid(`1 validation error detected: Value '${limit}' at 'limit' failed to satisfy constraint: Member must have value between 1 and ${max}`)
  }
  return limit as number
}

const scopeOf = (ctx: RequestContext) => ({ account: ctx.account, region: ctx.region })

function group(state: LogsState, name: unknown): LogGroup {
  const found = state.groups[validateName(name, 'logGroupName', GROUP_NAME)]
  if (!found) {
    throw noGroup()
  }
  return found
}

function stream(state: LogsState, groupName: unknown, streamName: unknown): { group: LogGroup; stream: LogStream } {
  const g = group(state, groupName)
  const s = g.streams[validateName(streamName, 'logStreamName', STREAM_NAME)]
  if (!s) {
    throw noStream()
  }
  return { group: g, stream: s }
}

// Runs an operation against the state and saves it.
function writing<T>(ctx: RequestContext, run: (state: LogsState) => T): T {
  const scope = scopeOf(ctx)
  const state = loadLogs(scope)
  const result = run(state)
  saveLogs(scope, state)
  return result
}

export function createLogGroup(ctx: RequestContext) {
  const { params: p } = ctx
  refuse(p, ['kmsKeyId'])
  if (p.logGroupClass !== undefined && p.logGroupClass !== 'STANDARD') {
    throw invalid(`logGroupClass '${p.logGroupClass}' is not supported by this simulator yet (only STANDARD)`)
  }
  const name = validateName(p.logGroupName, 'logGroupName', GROUP_NAME)
  return writing(ctx, state => {
    if (state.groups[name]) {
      throw new AwsError('ResourceAlreadyExistsException', 'The specified log group already exists', 400)
    }
    if (Object.keys(state.groups).length >= quota(scopeOf(ctx), QUOTAS.logGroupsPerRegion)) {
      throw new AwsError('LimitExceededException', 'Resource limit exceeded.', 400)
    }
    createGroup(state, name, p.tags ?? {})
    return {}
  })
}

export const deleteLogGroup = (ctx: RequestContext) => writing(ctx, state => {
  const g = group(state, ctx.params.logGroupName)
  removeGroupData(scopeOf(ctx), g)
  delete state.groups[g.logGroupName]
  return {}
})

export function describeLogGroups(ctx: RequestContext) {
  const { params: p } = ctx
  refuse(p, ['logGroupNamePattern', 'logGroupIdentifiers', 'accountIdentifiers', 'includeLinkedAccounts', 'logGroupClass'])
  const limit = pageSize(p.limit, 50, 50)
  const scope = scopeOf(ctx)
  const groups = Object.values(loadLogs(scope).groups)
    .filter(g => g.logGroupName.startsWith(p.logGroupNamePrefix ?? ''))
    .sort((a, b) => (a.logGroupName < b.logGroupName ? -1 : 1))
  const start = p.nextToken === undefined ? 0 : groups.findIndex(g => g.logGroupName > p.nextToken)
  const page = start < 0 ? [] : groups.slice(start, start + limit)
  return {
    logGroups: page.map(g => ({
      logGroupName: g.logGroupName,
      creationTime: g.creationTime,
      ...(g.retentionInDays === undefined ? {} : { retentionInDays: g.retentionInDays }),
      metricFilterCount: 0,
      arn: `${logGroupArn(scope, g.logGroupName)}:*`,
      storedBytes: storedBytes(g),
      logGroupClass: 'STANDARD',
      logGroupArn: logGroupArn(scope, g.logGroupName),
    })),
    ...(start >= 0 && start + limit < groups.length ? { nextToken: page.at(-1)!.logGroupName } : {}),
  }
}

export const createLogStream = (ctx: RequestContext) => writing(ctx, state => {
  const g = group(state, ctx.params.logGroupName)
  const name = validateName(ctx.params.logStreamName, 'logStreamName', STREAM_NAME)
  if (g.streams[name]) {
    throw new AwsError('ResourceAlreadyExistsException', 'The specified log stream already exists', 400)
  }
  createStream(g, name)
  return {}
})

export const deleteLogStream = (ctx: RequestContext) => writing(ctx, state => {
  const { group: g, stream: s } = stream(state, ctx.params.logGroupName, ctx.params.logStreamName)
  removeStreamData(scopeOf(ctx), g, s)
  delete g.streams[s.logStreamName]
  return {}
})

export function describeLogStreams(ctx: RequestContext) {
  const { params: p } = ctx
  refuse(p, ['logGroupIdentifier'])
  const limit = pageSize(p.limit, 50, 50)
  const orderBy = p.orderBy ?? 'LogStreamName'
  if (!['LogStreamName', 'LastEventTime'].includes(orderBy)) {
    throw invalid(`1 validation error detected: Value '${orderBy}' at 'orderBy' failed to satisfy constraint: Member must satisfy enum value set: [LogStreamName, LastEventTime]`)
  }
  if (orderBy === 'LastEventTime' && p.logStreamNamePrefix !== undefined) {
    throw invalid('Cannot order by LastEventTime with a logStreamNamePrefix.')
  }
  const scope = scopeOf(ctx)
  const g = group(loadLogs(scope), p.logGroupName)
  const streams = Object.values(g.streams).filter(s => s.logStreamName.startsWith(p.logStreamNamePrefix ?? ''))
  streams.sort(orderBy === 'LogStreamName'
    ? (a, b) => (a.logStreamName < b.logStreamName ? -1 : 1)
    : (a, b) => (a.lastEventTimestamp ?? 0) - (b.lastEventTimestamp ?? 0))
  if (p.descending) {
    streams.reverse()
  }
  const offset = p.nextToken === undefined ? 0 : Number(p.nextToken)
  const page = streams.slice(offset, offset + limit)
  return {
    logStreams: page.map(s => ({
      logStreamName: s.logStreamName,
      creationTime: s.creationTime,
      ...(s.firstEventTimestamp === undefined ? {} : { firstEventTimestamp: s.firstEventTimestamp, lastEventTimestamp: s.lastEventTimestamp, lastIngestionTime: s.lastIngestionTime }),
      arn: logStreamArn(scope, g.logGroupName, s.logStreamName),
      storedBytes: 0,
    })),
    ...(offset + limit < streams.length ? { nextToken: String(offset + limit) } : {}),
  }
}

export function putLogEvents(ctx: RequestContext) {
  const { params: p } = ctx
  const events: { timestamp: number; message: string }[] = p.logEvents ?? []
  if (!Array.isArray(events) || events.length === 0) {
    throw invalid("1 validation error detected: Value '[]' at 'logEvents' failed to satisfy constraint: Member must have length greater than or equal to 1")
  }
  const maxEvents = hardLimit(QUOTAS.putLogEventsBatchEvents)
  if (events.length > maxEvents) {
    throw invalid(`1 validation error detected: Value '[...]' at 'logEvents' failed to satisfy constraint: Member must have length less than or equal to ${maxEvents}`)
  }
  let batch = 0
  events.forEach((event, index) => {
    if (!Number.isInteger(event.timestamp) || typeof event.message !== 'string') {
      throw invalid(`1 validation error detected: logEvents[${index}] needs a timestamp and a message`)
    }
    if (eventSize(event.message) > hardLimit(QUOTAS.logEventSize)) {
      throw invalid(`Log event too large: ${eventSize(event.message)} bytes exceeds limit of ${hardLimit(QUOTAS.logEventSize)}`)
    }
    batch += eventSize(event.message)
    if (index > 0 && event.timestamp < events[index - 1].timestamp) {
      throw invalid('Log events in a single PutLogEvents request must be in chronological order.')
    }
  })
  if (batch > hardLimit(QUOTAS.putLogEventsBatchSize)) {
    throw invalid(`Batch too large: ${batch} bytes exceeds the limit of ${hardLimit(QUOTAS.putLogEventsBatchSize)}`)
  }
  return writing(ctx, state => {
    const { group: g, stream: s } = stream(state, p.logGroupName, p.logStreamName)
    const now = Date.now()
    const oldest = now - Math.min(FOURTEEN_DAYS, (g.retentionInDays ?? Infinity) * 86400000)
    // events that are too old or too far ahead are not stored; the response says which (indexes into the batch)
    const tooOld = events.filter(e => e.timestamp < oldest).length
    const tooNewFrom = events.findIndex(e => e.timestamp > now + TWO_HOURS)
    const accepted = events.filter((e, index) => e.timestamp >= oldest && (tooNewFrom < 0 || index < tooNewFrom))
    appendEvents(scopeOf(ctx), g, s, accepted, now)
    const rejected = {
      ...(tooOld ? { tooOldLogEventEndIndex: tooOld } : {}),
      ...(tooNewFrom >= 0 ? { tooNewLogEventStartIndex: tooNewFrom } : {}),
    }
    return Object.keys(rejected).length ? { rejectedLogEventsInfo: rejected } : {}
  })
}

const inRange = (e: LogEvent, start?: number, end?: number) => (start === undefined || e.timestamp >= start) && (end === undefined || e.timestamp < end)
const view = (e: LogEvent) => ({ timestamp: e.timestamp, message: e.message, ingestionTime: e.ingestionTime })

export function getLogEvents(ctx: RequestContext) {
  const { params: p } = ctx
  refuse(p, ['logGroupIdentifier', 'unmask'])
  const limit = pageSize(p.limit, MAX_READ, MAX_READ)
  const { group: g, stream: s } = stream(loadLogs(scopeOf(ctx)), p.logGroupName, p.logStreamName)
  // events with their position in the stream; the tokens are positions: f/<n> reads on from n, b/<n> reads back from n
  const events = readEvents(scopeOf(ctx), g, s)
  const all = events.map((e, index) => ({ e, index })).filter(({ e }) => inRange(e, p.startTime, p.endTime))
  let chosen: typeof all
  if (typeof p.nextToken === 'string') {
    const m = /^([fb])\/(\d+)$/.exec(p.nextToken)
    if (!m) {
      throw invalid('The specified nextToken is invalid.')
    }
    const position = Number(m[2])
    chosen = m[1] === 'f' ? all.filter(x => x.index >= position).slice(0, limit) : all.filter(x => x.index < position).slice(-limit)
    if (!chosen.length) {
      return { events: [], nextForwardToken: p.nextToken, nextBackwardToken: p.nextToken }
    }
  } else {
    chosen = p.startFromHead ? all.slice(0, limit) : all.slice(-limit)
  }
  if (!chosen.length) {
    return { events: [], nextForwardToken: `f/${events.length}`, nextBackwardToken: 'b/0' }
  }
  return {
    events: chosen.map(({ e }) => view(e)),
    nextForwardToken: `f/${chosen.at(-1)!.index + 1}`,
    nextBackwardToken: `b/${chosen[0].index}`,
  }
}

// Plain terms (and quoted phrases) that must all be in the message. The filter syntax for JSON, space-delimited and
// regular expression patterns is not modelled.
function termsOf(pattern: string): string[] {
  if (/^\s*[{[]|^\s*\?|%/.test(pattern) || /\s\?|\s-/.test(pattern)) {
    throw invalid(`Parameter 'filterPattern' uses a filter syntax that is not supported by this simulator yet (only plain terms: ${pattern})`)
  }
  return [...pattern.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2])
}

export function filterLogEvents(ctx: RequestContext) {
  const { params: p } = ctx
  refuse(p, ['logGroupIdentifier', 'unmask'])
  const limit = pageSize(p.limit, MAX_READ, MAX_READ)
  const g = group(loadLogs(scopeOf(ctx)), p.logGroupName)
  if (present(p.logStreamNames) && p.logStreamNamePrefix !== undefined) {
    throw invalid('logStreamNamePrefix and logStreamNames cannot both be given.')
  }
  const terms = termsOf(p.filterPattern ?? '')
  const names: string[] = p.logStreamNames ?? Object.keys(g.streams).filter(n => n.startsWith(p.logStreamNamePrefix ?? ''))
  const found = names.flatMap(name => {
    const s = g.streams[name]
    if (!s) {
      throw noStream()
    }
    return readEvents(scopeOf(ctx), g, s).map((e, index) => ({ e, name, index }))
  }).filter(({ e }) => inRange(e, p.startTime, p.endTime) && terms.every(t => e.message.includes(t)))
    .sort((a, b) => a.e.timestamp - b.e.timestamp || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.index - b.index))
  const offset = p.nextToken === undefined ? 0 : Number(p.nextToken)
  const page = found.slice(offset, offset + limit)
  return {
    events: page.map(({ e, name, index }) => ({ logStreamName: name, ...view(e), eventId: `${e.timestamp}${String(index).padStart(8, '0')}` })),
    searchedLogStreams: names.map(logStreamName => ({ logStreamName, searchedCompletely: true })),
    ...(offset + limit < found.length ? { nextToken: String(offset + limit) } : {}),
  }
}

export const putRetentionPolicy = (ctx: RequestContext) => writing(ctx, state => {
  const g = group(state, ctx.params.logGroupName)
  if (!RETENTION.includes(ctx.params.retentionInDays)) {
    throw invalid(`Invalid retentionInDays: ${ctx.params.retentionInDays}. Allowed values are ${RETENTION.join(', ')}.`)
  }
  g.retentionInDays = ctx.params.retentionInDays
  return {}
})

export const deleteRetentionPolicy = (ctx: RequestContext) => writing(ctx, state => {
  delete group(state, ctx.params.logGroupName).retentionInDays
  return {}
})

// The tags of a log group are addressed by its ARN, with or without the `:*` at the end.
function groupOfArn(state: LogsState, arn: unknown): LogGroup {
  const m = /^arn:aws:logs:[^:]+:\d{12}:log-group:([^:]+)(?::\*)?$/.exec(String(arn))
  const found = m && state.groups[m[1]]
  if (!found) {
    throw new AwsError('ResourceNotFoundException', 'The specified resource does not exist.', 400)
  }
  return found
}

export const listTagsForResource = (ctx: RequestContext) => ({ tags: groupOfArn(loadLogs(scopeOf(ctx)), ctx.params.resourceArn).tags })

export const tagResource = (ctx: RequestContext) => writing(ctx, state => {
  Object.assign(groupOfArn(state, ctx.params.resourceArn).tags, ctx.params.tags ?? {})
  return {}
})

export const untagResource = (ctx: RequestContext) => writing(ctx, state => {
  const g = groupOfArn(state, ctx.params.resourceArn)
  for (const tag of ctx.params.tagKeys ?? []) {
    delete g.tags[tag]
  }
  return {}
})
