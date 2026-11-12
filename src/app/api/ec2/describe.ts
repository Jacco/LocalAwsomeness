import { AwsError } from "../common"
import type { Resource, Tag } from "../data/ec2/state"

export interface Filter {
  Name: string
  Values?: string[]
}

// Maps a filter name to the candidate values of a record; a record matches when any candidate matches any filter value.
export type FilterFns<T> = Record<string, (item: T) => unknown>

export interface DescribeSpec<T> {
  items: T[]
  idOf: (item: T) => string
  ids?: string[]
  // Error vocabulary of the resource, e.g. { prefix: 'vpc', code: 'InvalidVpcID', noun: 'vpc ID' }. `malformed` and `notFound`
  // are the full codes for an ID with the wrong format or an unknown ID when they are not `<code>.Malformed` / `<code>.NotFound`.
  kind: { prefix: string; code: string; noun: string; nounPlural?: string; malformed?: string; notFound?: string }
  filters?: Filter[]
  filterFns: FilterFns<T>
  maxResults?: number
  nextToken?: string
}

const toStrings = (value: unknown): string[] =>
  (Array.isArray(value) ? value.flat() : [value]).filter(v => v !== undefined && v !== null).map(String)

// EC2 filter values support * and ? wildcards.
function matcher(pattern: string): (value: string) => boolean {
  if (!/[*?]/.test(pattern)) {
    return value => value === pattern
  }
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  return value => regex.test(value)
}

function tagFilter(name: string, tags: Tag[]): string[] | undefined {
  if (name === 'tag-key') {
    return tags.map(t => t.Key)
  }
  if (name === 'tag-value') {
    return tags.map(t => t.Value)
  }
  if (name.startsWith('tag:')) {
    return tags.filter(t => t.Key === name.slice(4)).map(t => t.Value)
  }
  return undefined
}

export function describe<T extends Resource>(spec: DescribeSpec<T>): { items: T[]; nextToken?: string } {
  const { kind } = spec
  let items = spec.items

  if (spec.ids?.length) {
    const malformed = spec.ids.find(id => !id.startsWith(`${kind.prefix}-`))
    if (malformed) {
      throw new AwsError(kind.malformed ?? `${kind.code}.Malformed`, `Invalid id: "${malformed}" (expecting "${kind.prefix}-...")`)
    }
    const known = new Set(items.map(spec.idOf))
    const missing = spec.ids.filter(id => !known.has(id))
    if (missing.length) {
      const plural = missing.length > 1
      throw new AwsError(kind.notFound ?? `${kind.code}.NotFound`, plural
        ? `The ${kind.nounPlural ?? `${kind.noun}s`} '${missing.join(', ')}' do not exist`
        : `The ${kind.noun} '${missing[0]}' does not exist`)
    }
    items = items.filter(item => spec.ids!.includes(spec.idOf(item)))
  }

  for (const filter of spec.filters ?? []) {
    const name = filter.Name
    const patterns = (filter.Values ?? []).map(matcher)
    const isTag = name === 'tag-key' || name === 'tag-value' || name.startsWith('tag:')
    if (!isTag && !spec.filterFns[name]) {
      throw new AwsError('InvalidParameterValue', `The filter '${name}' is invalid`)
    }
    items = items.filter(item => {
      const candidates = isTag ? tagFilter(name, item.Tags)! : toStrings(spec.filterFns[name](item))
      return candidates.some(candidate => patterns.some(match => match(candidate)))
    })
  }

  return paginate(items, spec.maxResults, spec.nextToken, spec.ids?.length ? kind.noun : undefined)
}

function paginate<T>(items: T[], maxResults?: number, nextToken?: string, idsGiven?: string) {
  if (maxResults === undefined && nextToken === undefined) {
    return { items }
  }
  if (maxResults !== undefined) {
    if (!Number.isInteger(maxResults) || maxResults < 5 || maxResults > 1000) {
      throw new AwsError('InvalidParameterValue', `Value ( ${maxResults} ) for parameter maxResults is invalid. Expecting a value between 5 and 1000.`)
    }
    if (idsGiven) {
      throw new AwsError('InvalidParameterCombination', 'The parameter maxResults cannot be used with the parameter ids')
    }
  }
  let start = 0
  if (nextToken !== undefined) {
    start = Number(Buffer.from(nextToken, 'base64').toString())
    if (!Number.isInteger(start) || start < 0) {
      throw new AwsError('InvalidParameterValue', 'Invalid value for NextToken')
    }
  }
  const size = maxResults ?? 1000
  const page = items.slice(start, start + size)
  return start + size < items.length
    ? { items: page, nextToken: Buffer.from(String(start + size)).toString('base64') }
    : { items: page }
}
