import { inflateRawSync } from "zlib"

// Reads a zip archive (a Lambda deployment package) into its files. Only what Lambda packages use: stored and deflated
// entries, no encryption, no zip64, no multi-disk archives. Anything else is reported, not guessed at.

export interface ZipEntry {
  // Relative path with `/` separators; never absolute, never containing `..`.
  name: string
  data: Buffer
}

export class ZipError extends Error {}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50

export interface ZipLimits {
  // The sum of the unzipped sizes; checked before anything is inflated.
  maxUnzippedBytes: number
}

export function readZip(zip: Buffer, limits: ZipLimits): ZipEntry[] {
  // the end record is in the last 22 bytes plus a comment of at most 65535 bytes
  let end = -1
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (zip.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) {
      end = at
      break
    }
  }
  if (end < 0) {
    throw new ZipError('not a zip archive: no end of central directory')
  }
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  if (count === 0xffff || at === 0xffffffff) {
    throw new ZipError('zip64 archives are not supported')
  }

  const central: { name: string; method: number; compressed: number; size: number; offset: number; encrypted: boolean }[] = []
  let total = 0
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new ZipError('the central directory is damaged')
    }
    const flags = zip.readUInt16LE(at + 8)
    const nameLength = zip.readUInt16LE(at + 28)
    const entry = {
      name: zip.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLength),
      method: zip.readUInt16LE(at + 10),
      compressed: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      offset: zip.readUInt32LE(at + 42),
      encrypted: (flags & 1) !== 0,
    }
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
    total += entry.size
    if (total > limits.maxUnzippedBytes) {
      throw new ZipError(`the unzipped size exceeds ${limits.maxUnzippedBytes} bytes`)
    }
    central.push(entry)
  }

  const files: ZipEntry[] = []
  for (const entry of central) {
    const name = entry.name.replace(/\\/g, '/')
    if (name.endsWith('/')) {
      continue
    }
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').some(part => part === '..')) {
      throw new ZipError(`the entry '${entry.name}' points outside the package`)
    }
    if (entry.encrypted) {
      throw new ZipError(`the entry '${entry.name}' is encrypted`)
    }
    if (zip.readUInt32LE(entry.offset) !== LOCAL_FILE_HEADER) {
      throw new ZipError(`the entry '${entry.name}' is damaged`)
    }
    const start = entry.offset + 30 + zip.readUInt16LE(entry.offset + 26) + zip.readUInt16LE(entry.offset + 28)
    const raw = zip.subarray(start, start + entry.compressed)
    let data: Buffer
    if (entry.method === 0) {
      data = Buffer.from(raw)
    } else if (entry.method === 8) {
      try {
        data = inflateRawSync(raw)
      } catch {
        throw new ZipError(`the entry '${entry.name}' cannot be inflated`)
      }
    } else {
      throw new ZipError(`the entry '${entry.name}' uses compression method ${entry.method}, which is not supported`)
    }
    if (data.length !== entry.size) {
      throw new ZipError(`the entry '${entry.name}' has the wrong size`)
    }
    files.push({ name: name.replace(/^(\.\/)+/, ''), data })
  }
  return files
}
