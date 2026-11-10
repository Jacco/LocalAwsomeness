import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs"

// The only place that knows where state lives on disk:
//   db/<service>.json                      no account (accounts, tokens)
//   db/<account>/<service>.json            account-wide (global) state
//   db/<account>/<region>/<service>.json   regional state
//   db/<account>/<region>/<service>/...    files that belong to a service's state (the code of Lambda functions)
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

// A directory of files that belongs to a service's state (the code of Lambda functions), next to its JSON:
//   db/<account>/<region>/<service>/<name>/...
export function directoryPath({ service, account, region }: StoreKey, ...names: string[]): string {
  if (!account) {
    throw Error('A directory belongs to an account')
  }
  return [DB_ROOT, account, region, service, ...names].filter(Boolean).join('/')
}

export function removeDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

export function listAccountDirs(): string[] {
  if (!existsSync(DB_ROOT)) {
    return []
  }
  return readdirSync(DB_ROOT).filter(dir => statSync(`${DB_ROOT}/${dir}`).isDirectory())
}
