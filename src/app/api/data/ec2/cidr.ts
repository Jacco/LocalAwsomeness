// IPv4 CIDR helpers. Addresses are handled as unsigned 32-bit integers.

export interface Cidr {
  address: number
  prefix: number
}

export function parseCidr(text: string): Cidr | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text)
  if (!m) {
    return undefined
  }
  const octets = m.slice(1, 5).map(Number)
  const prefix = Number(m[5])
  if (octets.some(o => o > 255) || prefix > 32) {
    return undefined
  }
  const address = octets.reduce((acc, o) => acc * 256 + o, 0)
  return { address, prefix }
}

const size = (prefix: number) => 2 ** (32 - prefix)

// A single address (no prefix), as an unsigned 32-bit integer.
export function parseAddress(text: string): number | undefined {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(text) ? parseCidr(`${text}/32`)?.address : undefined
}

export const formatAddress = (address: number) => formatCidr({ address, prefix: 32 }).slice(0, -3)

export const firstAddress = (c: Cidr) => c.address
export const lastAddress = (c: Cidr) => c.address + size(c.prefix) - 1
export const addressCount = (c: Cidr) => size(c.prefix)

// A CIDR is normalized when no host bits are set (10.0.0.0/16, not 10.0.0.1/16).
export function isNormalized(c: Cidr): boolean {
  return c.address % size(c.prefix) === 0
}

// Host bits cleared: 10.0.0.18/16 -> 10.0.0.0/16.
export const canonical = (c: Cidr): Cidr => ({ address: c.address - (c.address % size(c.prefix)), prefix: c.prefix })

export function overlaps(a: Cidr, b: Cidr): boolean {
  return firstAddress(a) <= lastAddress(b) && firstAddress(b) <= lastAddress(a)
}

export function contains(outer: Cidr, inner: Cidr): boolean {
  return firstAddress(outer) <= firstAddress(inner) && lastAddress(inner) <= lastAddress(outer)
}

export function formatCidr(c: Cidr): string {
  const a = c.address
  return `${Math.floor(a / 2 ** 24) % 256}.${Math.floor(a / 2 ** 16) % 256}.${Math.floor(a / 256) % 256}.${a % 256}/${c.prefix}`
}
