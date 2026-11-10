import * as store from "./store"

// CloudWatch Logs, for one account and Region, in two parts (see db/store.ts):
//   STATE  db/<account>/<region>/logs.json: log groups and, per stream, its metadata (when it was created, the timestamps of
//          its first and last event, when the last one came in, how many bytes it holds), in the shape of the API.
//   DATA   db/<account>/<region>/data/logs/<log group>/<log stream>.jsonl: the events of a stream, one JSON object per line,
//          in the order they arrived. The names are escaped to file names (`/aws/lambda/fn` is `%2Faws%2Flambda%2Ffn`).
// Retention is stored in the state but not enforced (events are never expired).

export interface LogEvent {
  timestamp: number
  message: string
  ingestionTime: number
}

export interface LogStream {
  logStreamName: string
  creationTime: number
  firstEventTimestamp?: number
  lastEventTimestamp?: number
  lastIngestionTime?: number
  // The size of the events in the stream, as AWS counts them (message bytes plus 26 per event).
  storedBytes: number
}

export interface LogGroup {
  logGroupName: string
  creationTime: number
  retentionInDays?: number
  tags: Record<string, string>
  streams: Record<string, LogStream>
}

export interface LogsState {
  groups: Record<string, LogGroup>
}

interface Scope {
  account: string
  region: string
}

const key = ({ account, region }: Scope): store.StoreKey => ({ service: 'logs', account, region })

export function loadLogs(scope: Scope): LogsState {
  const state = store.read<LogsState>(key(scope), { groups: {} })
  // streams written before the events moved to the data directory carried them in the state: drop them
  for (const group of Object.values(state.groups)) {
    for (const stream of Object.values(group.streams)) {
      delete (stream as { events?: unknown }).events
      stream.storedBytes ??= 0
    }
  }
  return state
}

export const saveLogs = (scope: Scope, state: LogsState) => store.write(key(scope), state)

export const logGroupArn = ({ account, region }: Scope, name: string) => `arn:aws:logs:${region}:${account}:log-group:${name}`
export const logStreamArn = (scope: Scope, group: string, stream: string) => `${logGroupArn(scope, group)}:log-stream:${stream}`

// The size of an event for the batch limit and the stored bytes: its UTF-8 bytes and 26 bytes of overhead.
export const eventSize = (message: string) => Buffer.byteLength(message) + 26

const groupDirectory = (scope: Scope, group: string) => store.dataPath(key(scope), store.fileName(group))
const streamFile = (scope: Scope, group: string, stream: string) => `${groupDirectory(scope, group)}/${store.fileName(stream)}.jsonl`

export function createGroup(state: LogsState, name: string, tags: Record<string, string> = {}, now = Date.now()): LogGroup {
  return (state.groups[name] = { logGroupName: name, creationTime: now, tags, streams: {} })
}

export function createStream(group: LogGroup, name: string, now = Date.now()): LogStream {
  return (group.streams[name] = { logStreamName: name, creationTime: now, storedBytes: 0 })
}

// The events of a stream, ordered by timestamp (the order of arrival for equal timestamps).
export function readEvents(scope: Scope, group: string, stream: string): LogEvent[] {
  return store.readJsonLines<LogEvent>(streamFile(scope, group, stream)).sort((a, b) => a.timestamp - b.timestamp)
}

// Adds events to a stream: the lines go to the data file, the metadata of the stream is updated (the caller saves the state).
export function appendEvents(scope: Scope, group: string, stream: LogStream, events: { timestamp: number; message: string }[], now = Date.now()): void {
  if (!events.length) {
    return
  }
  store.appendJsonLines(streamFile(scope, group, stream.logStreamName), events.map(e => ({ timestamp: e.timestamp, message: e.message, ingestionTime: now })))
  const timestamps = events.map(e => e.timestamp)
  stream.firstEventTimestamp = Math.min(stream.firstEventTimestamp ?? Infinity, ...timestamps)
  stream.lastEventTimestamp = Math.max(stream.lastEventTimestamp ?? -Infinity, ...timestamps)
  stream.lastIngestionTime = now
  stream.storedBytes += events.reduce((n, e) => n + eventSize(e.message), 0)
}

export const removeStreamData = (scope: Scope, group: string, stream: string) => store.removeData(streamFile(scope, group, stream))
export const removeGroupData = (scope: Scope, group: string) => store.removeData(groupDirectory(scope, group))

export const storedBytes = (group: LogGroup) => Object.values(group.streams).reduce((sum, s) => sum + s.storedBytes, 0)
