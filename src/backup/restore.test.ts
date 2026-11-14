import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RecordingKeyStore, recordingKeyStore, snapshotTree } from '../install/test-support'
import { PROJECT_A, seedMcpObservation, seedMcpSession } from '../mcp/test-support'
import { DB_KEY_NEXT_REF, DB_KEY_REF, DB_KEY_REPLACED_REF } from '../secrets/credentials'
import { dbKeyStoreOf, newDbKey } from '../sqlite/keys'
import { fileState, maintenancePath, openEncrypted, openPlain } from '../sqlite/open'
import type { Database } from '../sqlite/types'
import { DB_FILE } from '../store/data-dir'
import { type Store, openStore } from '../store/db'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../store/schema'
import { BackupError, type BackupErrorKind } from './archive'
import { createBackup } from './create'
import { FAULT_POINTS, type FaultPoint, RestoreCrash, applyRestore, asidePath, inspectBackup, replacedPath, resumeRestore, stageSnapshot, stagingDir } from './restore'
import { snapshotInto } from './snapshot'

let root: string
let serial = 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kf-restore-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

interface Source {
  archive: string
  key: string | null
}

interface Target {
  dataDir: string
  keyStore: RecordingKeyStore
  /** The key the target's own store was created with; null for plaintext or no store. */
  key: string | null
}

const fixedKeys = (key: string | null) => (key === null ? { name: 'none', read: () => null, exists: () => false } : { name: 'test', read: () => key, exists: () => true })

function seed(store: Store, title: string): void {
  const session = seedMcpSession(store, PROJECT_A, 'claude-code', `session-${title}`)
  seedMcpObservation(store, { projectKey: PROJECT_A, sessionId: session, title, at: 1_790_000_000_000 })
}

async function makeSource(options: { encrypted?: boolean; title?: string; prepare?: (db: Database) => void; claimSchema?: number } = {}): Promise<Source> {
  serial += 1
  const dataDir = join(root, `source-${serial}`)
  const key = options.encrypted === false ? null : newDbKey()
  const store = openStore(dataDir, { keys: fixedKeys(key) })
  seed(store, options.title ?? 'from the backup')
  options.prepare?.(store.db)
  const archive = join(root, `backup-${serial}.kfb`)
  await createBackup({
    dataDir,
    dest: archive,
    snapshot: (path) => {
      const version = snapshotInto(store.db, path)
      return options.claimSchema ?? version
    },
    version: '0.2.0',
    now: () => 1_794_000_000_000,
  })
  store.db.close()
  return { archive, key }
}

function makeTarget(options: { encrypted?: boolean; memory?: boolean; store?: boolean } = {}): Target {
  serial += 1
  const dataDir = join(root, `target-${serial}`)
  const keyStore = recordingKeyStore()
  const key = options.encrypted === false ? null : newDbKey()
  if (key !== null) keyStore.set(DB_KEY_REF, key)
  if (options.store === false) {
    mkdirSync(dataDir, { recursive: true })
    return { dataDir, keyStore, key }
  }
  const store = openStore(dataDir, { keys: fixedKeys(key) })
  if (options.memory === true) seed(store, 'was here before')
  store.db.close()
  return { dataDir, keyStore, key }
}

const noSleep = async (): Promise<void> => {}

async function restore(target: Target, source: Source, options: { key?: string | null; faultAt?: FaultPoint; keyStore?: RecordingKeyStore | null; lockAttempts?: number } = {}): Promise<string[]> {
  const header = inspectBackup(source.archive)
  const staged = await stageSnapshot({ dataDir: target.dataDir, archivePath: source.archive, header, key: options.key === undefined ? source.key : options.key })
  const outcome = await applyRestore({
    dataDir: target.dataDir,
    staged,
    keyStore: options.keyStore === undefined ? target.keyStore : options.keyStore,
    log: () => {},
    sleep: noSleep,
    ...(options.faultAt !== undefined ? { faultAt: options.faultAt } : {}),
    ...(options.lockAttempts !== undefined ? { lockAttempts: options.lockAttempts } : {}),
  })
  return outcome.lines
}

async function refusal(run: () => Promise<unknown>): Promise<BackupErrorKind | 'none'> {
  try {
    await run()
  } catch (error: unknown) {
    if (error instanceof BackupError) return error.kind
    throw error
  }
  return 'none'
}

/** The observation titles in the target's store, opened the way the daemon opens it: through the key store. */
function titles(target: Target): string[] {
  const store = openStore(target.dataDir, { keys: dbKeyStoreOf(target.keyStore) })
  try {
    return store.db.query<{ title: string }, []>('SELECT title FROM observations ORDER BY id').all().map((row) => row.title)
  } finally {
    store.db.close()
  }
}

/** Every file's mode and content, and every key store entry. Times are left out: a refused restore may create and remove its own temp folder. */
function tree(dataDir: string): Record<string, { mode: number; sha: string | null }> {
  return Object.fromEntries(Object.entries(snapshotTree(dataDir)).map(([path, entry]) => [path, { mode: entry.mode, sha: entry.sha }]))
}

function world(target: Target): { tree: ReturnType<typeof tree>; keys: [string, string][] } {
  return { tree: tree(target.dataDir), keys: [...target.keyStore.values].sort() }
}

function expectNoLeftovers(target: Target): void {
  const db = join(target.dataDir, DB_FILE)
  expect(existsSync(maintenancePath(db))).toBe(false)
  expect(existsSync(stagingDir(target.dataDir))).toBe(false)
  expect(existsSync(asidePath(db))).toBe(false)
  expect(target.keyStore.values.has(DB_KEY_NEXT_REF)).toBe(false)
}

describe('a restore that succeeds', () => {
  test('onto a fresh install: the backup replaces the empty store, whose key and file are gone', async () => {
    const source = await makeSource()
    const target = makeTarget()
    const lines = await restore(target, source)
    expect(titles(target)).toEqual(['from the backup'])
    expect(target.keyStore.values.get(DB_KEY_REF)).toBe(source.key!)
    expect(target.keyStore.values.has(DB_KEY_REPLACED_REF)).toBe(false)
    expect(existsSync(replacedPath(join(target.dataDir, DB_FILE)))).toBe(false)
    expectNoLeftovers(target)
    expect(lines.join('\n')).toContain('OpenRouter')
    expect(lines.join('\n')).toContain('redaction markers')
    for (const line of lines) expect(line).not.toContain(source.key!)
  })

  test('with no store yet: the backup becomes the store', async () => {
    const source = await makeSource()
    const target = makeTarget({ store: false })
    await restore(target, source)
    expect(titles(target)).toEqual(['from the backup'])
    expectNoLeftovers(target)
  })

  test('onto a store with memory: that store is kept beside, with its key under db-key-replaced', async () => {
    const source = await makeSource()
    const target = makeTarget({ memory: true })
    const lines = await restore(target, source)
    expect(titles(target)).toEqual(['from the backup'])
    const replaced = replacedPath(join(target.dataDir, DB_FILE))
    expect(target.keyStore.values.get(DB_KEY_REPLACED_REF)).toBe(target.key!)
    const kept = openEncrypted(replaced, target.keyStore.values.get(DB_KEY_REPLACED_REF)!, { readonly: true })
    expect(kept.query<{ title: string }, []>('SELECT title FROM observations').get()!.title).toBe('was here before')
    kept.close()
    expectNoLeftovers(target)
    const text = lines.join('\n')
    expect(text).toContain(replaced)
    expect(text).toContain(DB_KEY_REPLACED_REF)
    expect(text).toContain('switch back')
  })

  test('an older schema is migrated forward', async () => {
    serial += 1
    const dir = join(root, `old-${serial}`)
    mkdirSync(dir, { recursive: true })
    const key = newDbKey()
    const old = openEncrypted(join(dir, DB_FILE), key, { create: true })
    for (const sql of MIGRATIONS.slice(0, LATEST_SCHEMA_VERSION - 1)) old.run(sql)
    old.run(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION - 1}`)
    const archive = join(root, 'old.kfb')
    await createBackup({ dataDir: dir, dest: archive, snapshot: (path) => snapshotInto(old, path), version: '0.1.0', now: () => 1 })
    old.close()
    expect(inspectBackup(archive).manifest.schemaVersion).toBe(LATEST_SCHEMA_VERSION - 1)
    const target = makeTarget()
    await restore(target, { archive, key })
    const store = openStore(target.dataDir, { keys: dbKeyStoreOf(target.keyStore) })
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    store.db.close()
  })

  test('an unencrypted backup needs no code, warns, and leaves no database key behind', async () => {
    const source = await makeSource({ encrypted: false })
    const target = makeTarget()
    const lines = await restore(target, source, { key: null })
    expect(fileState(join(target.dataDir, DB_FILE))).toBe('plain')
    expect(target.keyStore.values.has(DB_KEY_REF)).toBe(false)
    expect(titles(target)).toEqual(['from the backup'])
    expect(lines.join('\n')).toContain('not encrypted')
  })

  test('an unencrypted backup restores where there is no key store', async () => {
    const source = await makeSource({ encrypted: false })
    const target = makeTarget({ encrypted: false })
    await restore(target, source, { key: null, keyStore: null })
    const plain = openPlain(join(target.dataDir, DB_FILE), { readonly: true })
    expect(plain.query<{ title: string }, []>('SELECT title FROM observations').get()!.title).toBe('from the backup')
    plain.close()
  })

  test("the backup's update-check choice replaces the install's, and nothing else in install.json", async () => {
    serial += 1
    const sourceDir = join(root, `source-${serial}`)
    const key = newDbKey()
    const store = openStore(sourceDir, { keys: fixedKeys(key) })
    writeFileSync(join(sourceDir, 'install.json'), JSON.stringify({ channel: 'npx', updateCheck: false, firstInstalledAt: 5 }))
    const archive = join(root, 'settings.kfb')
    await createBackup({ dataDir: sourceDir, dest: archive, snapshot: (path) => snapshotInto(store.db, path), version: '0.2.0', now: () => 1 })
    store.db.close()
    const target = makeTarget()
    writeFileSync(join(target.dataDir, 'install.json'), JSON.stringify({ channel: 'curl', updateCheck: true, firstInstalledAt: 9 }))
    await restore(target, { archive, key })
    expect(JSON.parse(readFileSync(join(target.dataDir, 'install.json'), 'utf8'))).toEqual({ channel: 'curl', updateCheck: false, firstInstalledAt: 9 })
  })
})

describe('a restore that is refused changes nothing', () => {
  test('a wrong recovery code', async () => {
    const source = await makeSource()
    const target = makeTarget({ memory: true })
    const before = world(target)
    expect(await refusal(() => restore(target, source, { key: newDbKey() }))).toBe('code')
    expect(world(target)).toEqual(before)
    expect(titles(target)).toEqual(['was here before'])
  })

  test('an encrypted backup with no code at all', async () => {
    const source = await makeSource()
    const target = makeTarget()
    const before = world(target)
    expect(await refusal(() => restore(target, source, { key: null }))).toBe('code')
    expect(world(target)).toEqual(before)
  })

  test('a truncated archive', async () => {
    const source = await makeSource()
    const bytes = readFileSync(source.archive)
    writeFileSync(source.archive, bytes.subarray(0, bytes.length - 100))
    const target = makeTarget()
    const before = world(target)
    expect(await refusal(() => restore(target, source))).toBe('truncated')
    expect(world(target)).toEqual(before)
  })

  test('a tampered archive', async () => {
    const source = await makeSource()
    const bytes = readFileSync(source.archive)
    const at = bytes.length - 2_000
    bytes[at] = bytes[at]! ^ 0xff
    writeFileSync(source.archive, bytes)
    const target = makeTarget()
    const before = world(target)
    expect(await refusal(() => restore(target, source))).toBe('tampered')
    expect(world(target)).toEqual(before)
  })

  test('a backup whose manifest names a newer schema, with the version it needs', async () => {
    const source = await makeSource({ claimSchema: LATEST_SCHEMA_VERSION + 2 })
    const target = makeTarget()
    const before = world(target)
    expect(await refusal(() => restore(target, source))).toBe('schema')
    expect(() => inspectBackup(source.archive)).toThrow(new RegExp(`schema ${LATEST_SCHEMA_VERSION + 2}`))
    expect(world(target)).toEqual(before)
  })

  test('a snapshot with a newer schema than its manifest admits', async () => {
    const source = await makeSource({ prepare: (db) => db.run(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`), claimSchema: LATEST_SCHEMA_VERSION })
    const target = makeTarget()
    const before = world(target)
    expect(await refusal(() => restore(target, source))).toBe('schema')
    expect(world(target)).toEqual(before)
  })

  test('an encrypted backup where there is no key store', async () => {
    const source = await makeSource()
    const target = makeTarget({ encrypted: false })
    const before = tree(target.dataDir)
    expect(await refusal(() => restore(target, source, { keyStore: null }))).toBe('key-store')
    expect(tree(target.dataDir)).toEqual(before)
  })

  test('a store kept by an earlier restore is in the way of keeping another', async () => {
    const source = await makeSource()
    const target = makeTarget({ memory: true })
    writeFileSync(replacedPath(join(target.dataDir, DB_FILE)), 'an earlier store')
    const before = world(target)
    expect(await refusal(() => restore(target, source))).toBe('state')
    expect(world(target)).toEqual(before)
  })

  test('a run that is already in progress', async () => {
    const source = await makeSource()
    const target = makeTarget()
    writeFileSync(maintenancePath(join(target.dataDir, DB_FILE)), JSON.stringify({ op: 'rekey', pid: process.pid, startedAt: 1, source: 'db-key', target: 'db-key-next' }))
    expect(await refusal(() => restore(target, source))).toBe('busy')
    expect(existsSync(maintenancePath(join(target.dataDir, DB_FILE)))).toBe(true)
  })

  test('another process holding memory.db: restore waits, then refuses', async () => {
    const source = await makeSource()
    const target = makeTarget({ memory: true })
    const holder = openEncrypted(join(target.dataDir, DB_FILE), target.key!)
    holder.query('SELECT count(*) FROM observations').get()
    try {
      const keysBefore = [...target.keyStore.values].sort()
      expect(await refusal(() => restore(target, source, { lockAttempts: 3 }))).toBe('busy')
      expect([...target.keyStore.values].sort()).toEqual(keysBefore)
      expectNoLeftovers(target)
    } finally {
      holder.close()
    }
    expect(titles(target)).toEqual(['was here before'])
  })
})

describe('a restore cut short is finished or undone by resume', () => {
  const ENDS: Readonly<Record<FaultPoint, 'undone' | 'finished'>> = {
    'after-journal': 'undone',
    'after-keys': 'undone',
    'after-move-aside': 'undone',
    'after-move-in': 'finished',
    'after-key-swap': 'finished',
  }

  for (const memory of [false, true]) {
    for (const point of FAULT_POINTS) {
      test(`killed ${point}, the store that was here ${memory ? 'holds memory' : 'is empty'}: ${ENDS[point]}`, async () => {
        const source = await makeSource()
        const target = makeTarget({ memory })
        await expect(restore(target, source, { faultAt: point })).rejects.toBeInstanceOf(RestoreCrash)
        const marker = maintenancePath(join(target.dataDir, DB_FILE))
        expect(existsSync(marker)).toBe(true)
        const journal = readFileSync(marker, 'utf8')
        expect(journal).not.toContain(source.key!)
        expect(journal).not.toContain(target.key!)

        const lines: string[] = []
        expect(resumeRestore({ dataDir: target.dataDir, keyStore: target.keyStore, log: (line) => lines.push(line) })).toBe(ENDS[point])
        expectNoLeftovers(target)
        const replaced = replacedPath(join(target.dataDir, DB_FILE))
        if (ENDS[point] === 'undone') {
          expect(titles(target)).toEqual(memory ? ['was here before'] : [])
          expect(target.keyStore.values.get(DB_KEY_REF)).toBe(target.key!)
          expect(target.keyStore.values.has(DB_KEY_REPLACED_REF)).toBe(false)
          expect(existsSync(replaced)).toBe(false)
        } else {
          expect(titles(target)).toEqual(['from the backup'])
          expect(target.keyStore.values.get(DB_KEY_REF)).toBe(source.key!)
          expect(existsSync(replaced)).toBe(memory)
          expect(target.keyStore.values.has(DB_KEY_REPLACED_REF)).toBe(memory)
          if (memory) openEncrypted(replaced, target.keyStore.values.get(DB_KEY_REPLACED_REF)!, { readonly: true }).close()
        }
        for (const line of lines) {
          expect(line).not.toContain(source.key!)
          expect(line).not.toContain(target.key!)
        }
      })
    }
  }

  test('resume with no restore journal says so and changes nothing', async () => {
    const target = makeTarget({ memory: true })
    const before = world(target)
    expect(() => resumeRestore({ dataDir: target.dataDir, keyStore: target.keyStore, log: () => {} })).toThrow(BackupError)
    expect(world(target)).toEqual(before)
  })

  test('restoring your own backup over the same key survives a kill at every point', async () => {
    for (const point of FAULT_POINTS) {
      const target = makeTarget({ memory: true })
      const store = openStore(target.dataDir, { keys: fixedKeys(target.key) })
      const archive = join(root, `own-${point}.kfb`)
      await createBackup({ dataDir: target.dataDir, dest: archive, snapshot: (path) => snapshotInto(store.db, path), version: '0.2.0', now: () => 1 })
      store.db.close()
      await expect(restore(target, { archive, key: target.key }, { faultAt: point })).rejects.toBeInstanceOf(RestoreCrash)
      resumeRestore({ dataDir: target.dataDir, keyStore: target.keyStore, log: () => {} })
      expectNoLeftovers(target)
      expect(titles(target)).toEqual(['was here before'])
      expect(target.keyStore.values.get(DB_KEY_REF)).toBe(target.key!)
    }
  })
})
