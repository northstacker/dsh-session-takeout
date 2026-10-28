/**
 * Minimal ZIP container codec.
 *
 * A session bundle has to survive a trip through Finder, AirDrop, a mail attachment
 * and a different machine, so the container must be a real ZIP that macOS and
 * Windows can open without this plugin. The Host therefore writes the archive itself
 * instead of shipping an extra dependency: deflate comes from `node:zlib`, and the
 * only thing missing from the standard library is the CRC-32 trailer, which is 20
 * lines of table arithmetic below.
 *
 * Supported: store and deflate entries, UTF-8 names, 32-bit sizes. Not supported
 * (and rejected explicitly rather than guessed): ZIP64, encryption, multi-disk and
 * spanned archives. Every archive this plugin writes is inside those limits.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const UTF8_NAME_FLAG = 0x0800
const VERSION_NEEDED = 20
const VERSION_MADE_BY = 0x0014
const UNLIMITED32 = 0xffffffff
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
const MAX_COMMENT = 0xffff
const UNIX_FILE_MODE = 0o644

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** CRC-32 as specified by the ZIP format (IEEE 802.3 polynomial, reflected). */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS date and time, which has two-second resolution and starts at 1980. */
function dosStamp(when) {
  const date = when instanceof Date && !Number.isNaN(when.getTime()) ? when : new Date()
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() & 0x3f) >> 1),
    date: ((year - 1980) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
  }
}

/**
 * Build a ZIP archive.
 *
 * @param {ReadonlyArray<{ name: string, data: Buffer | Uint8Array | string }>} entries
 * @param {Date} [when] timestamp recorded for every entry
 * @returns {Buffer}
 */
export function zipWrite(entries, when = new Date()) {
  const stamp = dosStamp(when)
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = String(entry.name || '')
    if (!name) throw new Error('zip entry without a name')
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : typeof entry.data === 'string'
        ? Buffer.from(entry.data, 'utf8')
        : Buffer.from(entry.data)

    // Deflate, but keep the stored form when compression does not pay for itself
    // (already-compressed image payloads often grow).
    const deflated = deflateRawSync(raw, { level: 9 })
    const compress = deflated.length < raw.length
    const body = compress ? deflated : raw
    const method = compress ? METHOD_DEFLATE : METHOD_STORE
    const checksum = crc32(raw)
    const nameBytes = Buffer.from(name, 'utf8')

    if (raw.length >= UNLIMITED32 || body.length >= UNLIMITED32) {
      throw new Error('zip entry too large for a 32-bit archive: ' + name)
    }

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(VERSION_NEEDED, 4)
    local.writeUInt16LE(UTF8_NAME_FLAG, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    central.writeUInt16LE(VERSION_MADE_BY, 4)
    central.writeUInt16LE(VERSION_NEEDED, 6)
    central.writeUInt16LE(UTF8_NAME_FLAG, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(stamp.time, 12)
    central.writeUInt16LE(stamp.date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE((UNIX_FILE_MODE << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD_SIGNATURE, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  if (entries.length > 0xffff) throw new Error('too many zip entries for a 32-bit archive')
  return Buffer.concat([...locals, directory, end])
}

/** Locate the end-of-central-directory record, allowing for a trailing comment. */
function findEndRecord(buffer) {
  const floor = Math.max(0, buffer.length - 22 - MAX_COMMENT)
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

/**
 * Read a ZIP archive into a name → bytes map.
 *
 * Verification is deliberately strict: a bundle that arrives truncated or corrupted
 * must fail here, before anything is written into the session store.
 *
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
export function zipRead(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('not a zip archive')
  const end = findEndRecord(buffer)
  if (end < 0) throw new Error('not a zip archive (no end record)')

  const count = buffer.readUInt16LE(end + 10)
  const directorySize = buffer.readUInt32LE(end + 12)
  const directoryOffset = buffer.readUInt32LE(end + 16)
  if (directoryOffset + directorySize > buffer.length) throw new Error('zip archive is truncated')
  if (count === 0xffff || directoryOffset === UNLIMITED32) {
    throw new Error('ZIP64 archives are not supported')
  }

  const files = new Map()
  let cursor = directoryOffset

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length) throw new Error('zip central directory is truncated')
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error('zip central directory is malformed')

    const method = buffer.readUInt16LE(cursor + 10)
    const checksum = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const rawSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    if (compressedSize === UNLIMITED32 || rawSize === UNLIMITED32) {
      throw new Error('ZIP64 entries are not supported')
    }
    if (localOffset + 30 > buffer.length) throw new Error('zip entry header is truncated: ' + name)
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error('zip entry header is malformed: ' + name)

    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const body = buffer.subarray(start, start + compressedSize)
    if (body.length !== compressedSize) throw new Error('zip entry body is truncated: ' + name)

    let data
    if (method === METHOD_STORE) data = Buffer.from(body)
    else if (method === METHOD_DEFLATE) data = inflateRawSync(body)
    else throw new Error('unsupported zip compression method ' + method + ': ' + name)

    if (data.length !== rawSize) throw new Error('zip entry size mismatch: ' + name)
    if (crc32(data) !== checksum) throw new Error('zip entry checksum mismatch: ' + name)

    files.set(name, data)
  }

  return files
}
