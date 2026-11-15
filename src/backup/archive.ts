// The backup file: one container holding a manifest and the store's snapshot.
//
//   bytes 0-7    "KFBACKUP"
//   bytes 8-11   format version, big-endian
//   bytes 12-15  manifest length, big-endian
//   then         the manifest as JSON
//   then         the snapshot, to the end of the file
//
// The snapshot is the store's own SQLite file, still encrypted with the
// store's key when the store is. Nothing here holds a key, a recovery code or
// a token: the manifest is a closed list of fields and parseManifest refuses
// any other. The manifest is advice (what to show, what to refuse early); the
// restore reads the schema version and the cipher from the snapshot itself.

import { closeSync, fstatSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isRecord } from '../contract/event'
import { DATA_FILE_MODE } from '../store/data-dir'

export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_FILE_EXTENSION = '.kfb'
export const MAX_MANIFEST_BYTES = 65_536

const MAGIC = Buffer.from('KFBACKUP', 'latin1')
const HEADER_BYTES = MAGIC.length + 8
const CHUNK_BYTES = 1024 * 1024
/** Chunks copied between two turns of the event loop, so a daemon copying a large file still answers /health. */
const CHUNKS_PER_TURN = 8

export interface BackupManifest {
  format: typeof BACKUP_FORMAT_VERSION
  kinfoldVersion: string
  /** The store's schema when the backup was made; restore refuses a newer one. */
  schemaVersion: number
  /** Milliseconds since the epoch. */
  createdAt: number
  encrypted: boolean
  snapshot: { sha256: string; bytes: number }
  /** The user's choices that live outside the database. */
  settings: { updateCheck?: boolean }
}

export type BackupErrorKind = 'format' | 'truncated' | 'tampered' | 'schema' | 'code' | 'busy' | 'state' | 'space' | 'key-store'

/** A refusal with a fixed message: never a key, a code or file content. */
export class BackupError extends Error {
  constructor(readonly kind: BackupErrorKind, message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

export interface ArchiveHeader {
  manifest: BackupManifest
  /** Where the snapshot starts in the file. */
  snapshotOffset: number
}

const notOurs = (): BackupError => new BackupError('format', 'this file is not a Kinfold backup')
const cutShort = (): BackupError => new BackupError('truncated', 'the backup file is cut short; copy it again from where it was saved')

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** The manifest from parsed JSON; any unknown, missing or malformed field is a format refusal. */
export function parseManifest(value: unknown): BackupManifest {
  if (!isRecord(value) || !hasOnly(value, ['format', 'kinfoldVersion', 'schemaVersion', 'createdAt', 'encrypted', 'snapshot', 'settings'])) throw notOurs()
  const { format, kinfoldVersion, schemaVersion, createdAt, encrypted, snapshot, settings } = value
  if (format !== BACKUP_FORMAT_VERSION || typeof kinfoldVersion !== 'string' || kinfoldVersion.length > 64) throw notOurs()
  if (!isCount(schemaVersion) || !isCount(createdAt) || typeof encrypted !== 'boolean') throw notOurs()
  if (!isRecord(snapshot) || !hasOnly(snapshot, ['sha256', 'bytes'])) throw notOurs()
  if (typeof snapshot.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot.sha256) || !isCount(snapshot.bytes) || snapshot.bytes === 0) throw notOurs()
  if (!isRecord(settings) || !hasOnly(settings, ['updateCheck'])) throw notOurs()
  if (settings.updateCheck !== undefined && typeof settings.updateCheck !== 'boolean') throw notOurs()
  return {
    format,
    kinfoldVersion,
    schemaVersion,
    createdAt,
    encrypted,
    snapshot: { sha256: snapshot.sha256, bytes: snapshot.bytes },
    settings: settings.updateCheck === undefined ? {} : { updateCheck: settings.updateCheck },
  }
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Reads exactly `length` bytes at `position`, or fewer at the end of the file. */
function readAt(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, position + filled)
    if (read === 0) break
    filled += read
  }
  return buffer.subarray(0, filled)
}

/** Feeds `length` bytes from `position` to `each`, a chunk at a time; false when the file ends first. */
async function eachChunk(fd: number, position: number, length: number, each: (chunk: Buffer) => void): Promise<boolean> {
  let done = 0
  for (let chunks = 1; done < length; chunks += 1) {
    const chunk = readAt(fd, Math.min(CHUNK_BYTES, length - done), position + done)
    if (chunk.length === 0) return false
    each(chunk)
    done += chunk.length
    if (chunks % CHUNKS_PER_TURN === 0) await turn()
  }
  return true
}

function writeAll(fd: number, bytes: Buffer): void {
  let written = 0
  while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written)
}

export async function sha256OfFile(path: string): Promise<string> {
  const fd = openSync(path, 'r')
  try {
    const hash = createHash('sha256')
    await eachChunk(fd, 0, fstatSync(fd).size, (chunk) => hash.update(chunk))
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}

/** Writes a new file (0600); an existing `dest` throws, and a failed write removes what it wrote. */
export async function writeArchive(dest: string, manifest: BackupManifest, snapshotPath: string): Promise<void> {
  const json = Buffer.from(JSON.stringify(parseManifest(manifest)), 'utf8')
  if (json.length > MAX_MANIFEST_BYTES) throw new BackupError('format', 'the backup manifest is too large')
  const header = Buffer.alloc(HEADER_BYTES)
  MAGIC.copy(header)
  header.writeUInt32BE(BACKUP_FORMAT_VERSION, MAGIC.length)
  header.writeUInt32BE(json.length, MAGIC.length + 4)
  const out = openSync(dest, 'wx', DATA_FILE_MODE)
  try {
    const source = openSync(snapshotPath, 'r')
    try {
      if (fstatSync(source).size !== manifest.snapshot.bytes) throw new BackupError('state', 'the snapshot changed size while the backup was written')
      writeAll(out, header)
      writeAll(out, json)
      await eachChunk(source, 0, manifest.snapshot.bytes, (chunk) => writeAll(out, chunk))
    } finally {
      closeSync(source)
    }
  } catch (error: unknown) {
    closeSync(out)
    rmSync(dest, { force: true })
    throw error
  }
  closeSync(out)
}

/** The manifest and where the snapshot starts, once the container's shape and length check out. The snapshot's hash is checked by extractSnapshot. */
export function readArchive(path: string): ArchiveHeader {
  const fd = openSync(path, 'r')
  try {
    const head = readAt(fd, HEADER_BYTES, 0)
    if (head.length < MAGIC.length) throw cutShort()
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw notOurs()
    if (head.length < HEADER_BYTES) throw cutShort()
    const format = head.readUInt32BE(MAGIC.length)
    if (format !== BACKUP_FORMAT_VERSION) throw new BackupError('format', `this backup is format ${format}; this Kinfold reads format ${BACKUP_FORMAT_VERSION}. Update Kinfold, then restore`)
    const length = head.readUInt32BE(MAGIC.length + 4)
    if (length === 0 || length > MAX_MANIFEST_BYTES) throw notOurs()
    const json = readAt(fd, length, HEADER_BYTES)
    if (json.length < length) throw cutShort()
    let parsed: unknown
    try {
      parsed = JSON.parse(json.toString('utf8'))
    } catch {
      throw notOurs()
    }
    const manifest = parseManifest(parsed)
    const snapshotOffset = HEADER_BYTES + length
    const size = fstatSync(fd).size
    if (size < snapshotOffset + manifest.snapshot.bytes) throw cutShort()
    if (size > snapshotOffset + manifest.snapshot.bytes) throw notOurs()
    return { manifest, snapshotOffset }
  } finally {
    closeSync(fd)
  }
}

/** Copies the snapshot out to a new file (0600) and checks its SHA-256 against the manifest; on any failure `dest` is removed. */
export async function extractSnapshot(path: string, header: ArchiveHeader, dest: string): Promise<void> {
  const { bytes, sha256 } = header.manifest.snapshot
  const fd = openSync(path, 'r')
  let out: number
  try {
    out = openSync(dest, 'wx', DATA_FILE_MODE)
  } catch (error: unknown) {
    closeSync(fd)
    throw error
  }
  try {
    const hash = createHash('sha256')
    const whole = await eachChunk(fd, header.snapshotOffset, bytes, (chunk) => {
      hash.update(chunk)
      writeAll(out, chunk)
    })
    if (!whole) throw cutShort()
    if (hash.digest('hex') !== sha256) throw new BackupError('tampered', 'the backup file is damaged: its contents do not match its checksum. Nothing was changed')
  } catch (error: unknown) {
    closeSync(out)
    closeSync(fd)
    rmSync(dest, { force: true })
    throw error
  }
  closeSync(out)
  closeSync(fd)
}
