import { AwsError } from '../common'
import { queryError, queryResponse } from '../query'
import type { ProtocolAdapter } from '../registry'

export const CLOUDFORMATION_NS = 'http://cloudformation.amazonaws.com/doc/2010-05-15/'
const API_VERSION = '2010-05-15'

type Node = { [key: string]: Node | string }

// `Tags.member.1.Key=a` -> { Tags: { member: { 1: { Key: 'a' } } } }
function nest(form: URLSearchParams): Node {
  const root: Node = {}
  for (const [key, value] of form) {
    if (key === 'Action' || key === 'Version') continue
    const parts = key.split('.')
    let node = root
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== 'object') node[part] = {}
      node = node[part] as Node
    }
    node[parts.at(-1)!] = value
  }
  return root
}

// { member: { 1: x, 2: y } } -> [x, y]
function collapseLists(value: Node | string): unknown {
  if (typeof value === 'string') return value
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === 'member' && typeof value.member === 'object') {
    const items = value.member as Node
    return Object.keys(items)
      .sort((a, b) => Number(a) - Number(b))
      .map(index => collapseLists(items[index]))
  }
  return Object.fromEntries(keys.map(key => [key, collapseLists(value[key])]))
}

// Arrays serialize as <Name><member>..</member></Name> in the query protocol.
function wrapLists(value: unknown): unknown {
  if (Array.isArray(value)) return { member: value.map(wrapLists) }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, wrapLists(v)]))
  }
  return value
}

// Form body with Action= and XML responses, as sent by the AWS CLI, boto3 and terraform.
export class CloudFormationQueryProtocol implements ProtocolAdapter<Record<string, any>> {
  async decode(request: Request) {
    const form = new URLSearchParams(await request.text())
    return {
      action: form.get('Action') ?? '',
      params: collapseLists(nest(form)) as Record<string, any>,
    }
  }

  unknownOperation(action: string) {
    return new AwsError('InvalidAction', `Could not find operation ${action} for version ${API_VERSION}`)
  }

  success(action: string, result: unknown) {
    return queryResponse(CLOUDFORMATION_NS, action, wrapLists(result) as Record<string, unknown> | undefined)
  }

  failure(error: unknown) {
    return queryError(CLOUDFORMATION_NS, error)
  }
}

export function toBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  return value === true || value === 'true'
}

export function toInteger(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}
