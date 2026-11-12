import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs"

// The only place that knows where things live on disk. Two kinds, kept apart:
//
// STATE is what the API describes: small JSON records, one file per service, that a Describe/List call is built from, and the
// files that are part of a resource's definition (the code of a Lambda function, a directory next to the JSON).
//   db/<service>.json                      no account (accounts, tokens)
//   db/<account>/<service>.json            account-wide (global) state
//   db/<account>/<region>/<service>.json   regional state
//   db/<account>/<region>/<service>/...    files that belong to a service's state
//
// DATA is content and what the simulator observed: the events of a log stream, the invocation records of a function (later
// the objects of a bucket). Bulky, written by appending or replacing, never read as a whole by a Describe call. It lives under
// a `data` directory of its own, one directory per service:
//   db/<account>/data/<service>/...             account-wide data
//   db/<account>/<region>/data/<service>/...    regional data
// State may point at data (a log stream's state says when its last event was and which file holds its events), never the other
// way. The names of data directories and files are readable versions of the names they belong to, chosen when the thing is
// created and kept in the state (see readableName and uniqueName below), not escapes that have to be decoded.
export const DB_ROOT = process.env.JPK_DB_ROOT ?? 'db'

export interface StoreKey {
  service: string
  account?: string
  region?: string
}

export function storePath({ service, account, region }: StoreKey): string {
  if (region && !account) {
    throw Error('A region requires an account')
  }
  return [DB_ROOT, account, region, `${service}.json`].filter(Boolean).join('/')
}

export function exists(key: StoreKey): boolean {
  return existsSync(storePath(key))
}

// Returns `fallback` when nothing has been stored yet.
export function read<T>(key: StoreKey, fallback: T): T {
  const fn = storePath(key)
  return existsSync(fn) ? JSON.parse(readFileSync(fn).toString()) : fallback
}

// Written to a temporary file first so a crash never leaves a half-written state file.
export function write(key: StoreKey, data: unknown): void {
  const fn = storePath(key)
  const dir = fn.slice(0, fn.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  const tmp = `${fn}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, fn)
}

export function update<T>(key: StoreKey, fallback: T, fn: (state: T) => void): T {
  const state = read(key, fallback)
  fn(state)
  write(key, state)
  return state
}

export function remove(key: StoreKey): void {
  unlinkSync(storePath(key))
}

export function accountDirExists(account: string): boolean {
  return existsSync(`${DB_ROOT}/${account}`)
}

// A directory of files that is part of a resource's definition, next to the JSON of its service (state, not data):
//   db/<account>/<region>/<service>/<name>/...
export function directoryPath({ service, account, region }: StoreKey, ...names: string[]): string {
  if (!account) {
    throw Error('A directory belongs to an account')
  }
  return [DB_ROOT, account, region, service, ...names].filter(Boolean).join('/')
}

// The directory of a service's data (see above), or a path inside it. File names that come from API names go through
// readableName() and uniqueName(), or safeFileName() when the API already restricts the name.
export function dataPath({ service, account, region }: StoreKey, ...names: string[]): string {
  if (!account) {
    throw Error('Data belongs to an account')
  }
  return [DB_ROOT, account, region, 'data', service, ...names].filter(Boolean).join('/')
}

// A name from the API as a file name that is easy to read: runs of anything but letters, digits, `.`, `-` and `_` become one
// `_` (`/aws/lambda/orders-fn` is `aws_lambda_orders-fn`), leading dots and underscores and trailing underscores are dropped,
// and it is cut at 100 characters. Not reversible and not unique: the state keeps the real name and the file name that was
// chosen for it (see uniqueName), so nothing ever has to be decoded.
export function readableName(name: string): string {
  const readable = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').replace(/_+$/, '').slice(0, 100)
  return readable === '' ? '_' : readable
}

// `readableName`, made different from the names that are taken (compared without regard to case, since a file system may
// not tell `A` from `a`) by adding -2, -3, ...
export function uniqueName(name: string, taken: string[], suffix = ''): string {
  const used = new Set(taken.map(t => t.toLowerCase()))
  const base = readableName(name)
  let candidate = `${base}${suffix}`
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = `${base}-${n}${suffix}`
  }
  return candidate
}

// For names the API already restricts to something safe (a Lambda function name): used as the file name itself, and refused
// when it could be anything else.
export function safeFileName(name: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/.test(name)) {
    throw Error(`'${name}' cannot be used as a file name`)
  }
  return name
}

export function removeData(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

export const removeDirectory = removeData

export function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? JSON.parse(readFileSync(path).toString()) : fallback
}

// Like write(), for a file of data.
export function writeJson(path: string, data: unknown): void {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, path)
}

// JSON Lines: one JSON value per line, appended as they come, readable with any text tool.
export function appendJsonLines(path: string, values: unknown[]): void {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  appendFileSync(path, values.map(v => `${JSON.stringify(v)}\n`).join(''))
}

export function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) {
    return []
  }
  return readFileSync(path).toString().split('\n').filter(line => line !== '').map(line => JSON.parse(line))
}

export function listAccountDirs(): string[] {
  if (!existsSync(DB_ROOT)) {
    return []
  }
  return readdirSync(DB_ROOT).filter(dir => statSync(`${DB_ROOT}/${dir}`).isDirectory())
}
