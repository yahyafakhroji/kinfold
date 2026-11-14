import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { BACKUP_FORMAT_VERSION, type BackupManifest, BackupError, MAX_MANIFEST_BYTES, extractSnapshot, parseManifest, readArchive, sha256OfFile, writeArchive } from './archive'

let dir: string
let snapshot: string
let archive: string
let content: Buffer

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kf-archive-'))
  snapshot = join(dir, 'snapshot.db')
  archive = join(dir, 'backup.kfb')
  // Larger than one copy chunk, so the chunked paths run.
  content = randomBytes(3 * 1024 * 1024 + 17)
  writeFileSync(snapshot, content)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function manifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    format: BACKUP_FORMAT_VERSION,
    kinfoldVersion: '0.2.0',
    schemaVersion: 11,
    createdAt: 1_794_000_000_000,
    encrypted: true,
    snapshot: { sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length },
    settings: { updateCheck: true },
    ...overrides,
  }
}

function kindOf(run: () => unknown): string {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof BackupError) return error.kind
    throw error
  }
  return 'none'
}

async function kindOfAsync(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error: unknown) {
    if (error instanceof BackupError) return error.kind
    throw error
  }
  return 'none'
}

test('an archive round-trips its manifest and snapshot', async () => {
  await writeArchive(archive, manifest(), snapshot)
  const header = readArchive(archive)
  expect(header.manifest).toEqual(manifest())
  const out = join(dir, 'out.db')
  await extractSnapshot(archive, header, out)
  expect(readFileSync(out).equals(content)).toBe(true)
  expect(await sha256OfFile(out)).toBe(manifest().snapshot.sha256)
})

test('the archive and the extracted snapshot are owner-only', async () => {
  if (process.platform === 'win32') return
  await writeArchive(archive, manifest(), snapshot)
  const out = join(dir, 'out.db')
  await extractSnapshot(archive, readArchive(archive), out)
  expect(statSync(archive).mode & 0o777).toBe(0o600)
  expect(statSync(out).mode & 0o777).toBe(0o600)
})

test('writeArchive never replaces an existing file', async () => {
  writeFileSync(archive, 'mine')
  await expect(writeArchive(archive, manifest(), snapshot)).rejects.toThrow()
  expect(readFileSync(archive, 'utf8')).toBe('mine')
})

test('a file that is not a backup is refused as format', () => {
  writeFileSync(archive, 'SQLite format 3\0 and more bytes than a header needs')
  expect(kindOf(() => readArchive(archive))).toBe('format')
})

test('an unknown format version is refused and named', async () => {
  await writeArchive(archive, manifest(), snapshot)
  const bytes = readFileSync(archive)
  bytes.writeUInt32BE(7, 8)
  writeFileSync(archive, bytes)
  expect(() => readArchive(archive)).toThrow(/format 7/)
  expect(kindOf(() => readArchive(archive))).toBe('format')
})

test('a manifest length past the limit is refused before it is read', async () => {
  await writeArchive(archive, manifest(), snapshot)
  const bytes = readFileSync(archive)
  bytes.writeUInt32BE(MAX_MANIFEST_BYTES + 1, 12)
  writeFileSync(archive, bytes)
  expect(kindOf(() => readArchive(archive))).toBe('format')
})

test('a file cut short is refused as truncated, at any length', async () => {
  await writeArchive(archive, manifest(), snapshot)
  const bytes = readFileSync(archive)
  for (const length of [0, 5, 12, 40, bytes.length - 1]) {
    writeFileSync(archive, bytes.subarray(0, length))
    expect(kindOf(() => readArchive(archive))).toBe('truncated')
  }
})

test('extra bytes after the snapshot are refused', async () => {
  await writeArchive(archive, manifest(), snapshot)
  writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from('x')]))
  expect(kindOf(() => readArchive(archive))).toBe('format')
})

test('one changed snapshot byte is refused as tampered and leaves no output', async () => {
  await writeArchive(archive, manifest(), snapshot)
  const header = readArchive(archive)
  const bytes = readFileSync(archive)
  const at = header.snapshotOffset + 1_000_000
  bytes[at] = bytes[at]! ^ 0xff
  writeFileSync(archive, bytes)
  const out = join(dir, 'out.db')
  expect(await kindOfAsync(() => extractSnapshot(archive, readArchive(archive), out))).toBe('tampered')
  expect(existsSync(out)).toBe(false)
})

test('a manifest must hold exactly the known fields, well formed', () => {
  const good = manifest()
  expect(parseManifest(JSON.parse(JSON.stringify(good)))).toEqual(good)
  expect(parseManifest({ ...good, settings: {} })).toEqual({ ...good, settings: {} })
  const bad: unknown[] = [
    null,
    [],
    { ...good, key: 'aa' },
    { ...good, schemaVersion: -1 },
    { ...good, schemaVersion: 1.5 },
    { ...good, encrypted: 'yes' },
    { ...good, createdAt: 'now' },
    { ...good, kinfoldVersion: 7 },
    { ...good, snapshot: { sha256: 'short', bytes: 1 } },
    { ...good, snapshot: { ...good.snapshot, bytes: 0 } },
    { ...good, snapshot: { ...good.snapshot, extra: 1 } },
    { ...good, settings: { updateCheck: 'on' } },
    { ...good, settings: { token: 'x' } },
    (() => {
      const { settings: _settings, ...rest } = good
      return rest
    })(),
  ]
  for (const value of bad) expect(kindOf(() => parseManifest(value))).toBe('format')
})

test('a manifest that is not JSON is refused as format', async () => {
  await writeArchive(archive, manifest(), snapshot)
  const bytes = readFileSync(archive)
  bytes.write('{{', 16)
  writeFileSync(archive, bytes)
  expect(kindOf(() => readArchive(archive))).toBe('format')
})
