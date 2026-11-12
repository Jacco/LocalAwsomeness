import { randomBytes } from "crypto"

// Resource IDs use the long format: a prefix and 17 lowercase hex characters.
export const ID_PREFIXES = {
  vpc: 'vpc',
  subnet: 'subnet',
  'route-table': 'rtb',
  'network-acl': 'acl',
  'security-group': 'sg',
  'internet-gateway': 'igw',
  'dhcp-options': 'dopt',
  'nat-gateway': 'nat',
  'elastic-ip': 'eipalloc',
  'network-interface': 'eni',
} as const

export type ResourceType = keyof typeof ID_PREFIXES

// Also used for association IDs, which have their own prefixes (rtbassoc, aclassoc, vpc-cidr-assoc, sgr, ...).
export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(9).toString('hex').slice(0, 17)}`
}

export const newResourceId = (type: ResourceType) => newId(ID_PREFIXES[type])

export function resourceTypeOfId(id: string): ResourceType | undefined {
  return (Object.keys(ID_PREFIXES) as ResourceType[]).find(type => id.startsWith(`${ID_PREFIXES[type]}-`))
}
