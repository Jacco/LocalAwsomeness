import * as store from "./store"

// State of CloudWatch Logs for one account and Region (db/<account>/<region>/logs.json): log groups with their streams and the
// events in them, in the shape of the API. Retention is stored but not enforced (events are never expired).

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
  // Events in the order of their timestamps (the order of arrival for equal timestamps).
  events: LogEvent[]
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

export const loadLogs = (scope: Scope): LogsState => store.read<LogsState>(key(scope), { groups: {} })
export const saveLogs = (scope: Scope, state: LogsState) => store.write(key(scope), state)

export const logGroupArn = ({ account, region }: Scope, name: string) => `arn:aws:logs:${region}:${account}:log-group:${name}`
export const logStreamArn = (scope: Scope, group: string, stream: string) => `${logGroupArn(scope, group)}:log-stream:${stream}`

// The size of an event for the batch limit and the stored bytes: its UTF-8 bytes and 26 bytes of overhead.
export const eventSize = (message: string) => Buffer.byteLength(message) + 26

export function createGroup(state: LogsState, name: string, tags: Record<string, string> = {}, now = Date.now()): LogGroup {
  return (state.groups[name] = { logGroupName: name, creationTime: now, tags, streams: {} })
}

export function createStream(group: LogGroup, name: string, now = Date.now()): LogStream {
  return (group.streams[name] = { logStreamName: name, creationTime: now, events: [] })
}

// Adds events to a stream, keeping them ordered by timestamp.
export function appendEvents(stream: LogStream, events: { timestamp: number; message: string }[], now = Date.now()): void {
  for (const event of events) {
    const entry: LogEvent = { timestamp: event.timestamp, message: event.message, ingestionTime: now }
    let at = stream.events.length
    while (at > 0 && stream.events[at - 1].timestamp > entry.timestamp) {
      at--
    }
    stream.events.splice(at, 0, entry)
  }
  if (events.length) {
    stream.firstEventTimestamp = stream.events[0].timestamp
    stream.lastEventTimestamp = stream.events.at(-1)!.timestamp
    stream.lastIngestionTime = now
  }
}

export const storedBytes = (group: LogGroup) =>
  Object.values(group.streams).reduce((sum, s) => sum + s.events.reduce((n, e) => n + eventSize(e.message), 0), 0)
