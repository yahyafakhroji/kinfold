import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RecordingKeyStore, recordingKeyStore, snapshotTree } from '../install/test-support'
import { PROJECT_A, seedMcpObservation, seedMcpSession } from '../mcp/test-support'
import { DB_KEY_NEXT_REF, DB_KEY_REF, DB_KEY_REPLACED_REF } from '../../../resources/secrets/credentials'
import { dbKeyStoreOf, newDbKey } from '../../../resources/sqlite/keys'
import { MAINTENANCE_FILE, fileState, maintenancePath, openEncrypted, openPlain } from '../../../resources/sqlite/open'
import { DB_FILE } from '../../../resources/store/data-dir'
import { type Store, openStore } from '../../../resources/store/db'
import { BackupError, type BackupErrorKind } from '../../../resources/backup/archive'
import { createBackup } from '../../../resources/backup/create'
import { readUndoJournal } from '../../../resources/backup/journal'
import { RestoreStranded, applyRestore, asidePath, inspectBackup, replacedPath, stageSnapshot } from '../../../resources/backup/restore'
import { snapshotInto } from '../../../resources/backup/snapshot'
import { templateStore } from '../../../resources/tests/backup/store-templates.test-support'
import { UNDO_FAULT_POINTS, type UndoFaultPoint, UndoCrash, applyUndo, checkUndo, keptStore, resumeUndo } from '../../../resources/backup/undo'

let root: string
let serial = 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kf-undo-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

type Kind = 'encrypted' | 'plain'
const KINDS: readonly Kind[] = ['encrypted', 'plain']
const WAS_HERE = 'was here before'
const FROM_BACKUP = 'from the backup'
const NOW = 1_795_000_000_000

/** A data folder after a restore that kept the store it replaced. */
interface Pair {
  dataDir: string
  keyStore: RecordingKeyStore
  /** The key of the store in use (the restored one); null when it is plaintext. */
  currentKey: string | null
  /** The key of the kept store; null when it is plaintext. */
  keptKey: string | null
}

const fixedKeys = (key: string | null) => (key === null ? { name: 'none', read: () => null, exists: () => false } : { name: 'test', read: () => key, exists: () => true })

function seed(store: Store, title: string): void {
  const session = seedMcpSession(store, PROJECT_A, 'claude-code', `session-${title}`)
  seedMcpObservation(store, { projectKey: PROJECT_A, sessionId: session, title, at: 1_790_000_000_000 })
}

const noSleep = async (): Promise<void> => {}

/** A store with memory of kind `kept`, then a backup of kind `current` restored over it. */
async function makePair(current: Kind, kept: Kind, sameKey = false): Promise<Pair> {
  serial += 1
  const dataDir = join(root, `target-${serial}`)
  const { key: keptKey } = templateStore(kept, dataDir)
  const sourceDir = join(root, `source-${serial}`)
  const { key: currentKey } = templateStore(current, sourceDir, sameKey && keptKey !== null ? keptKey : undefined)
  const source = openStore(sourceDir, { keys: fixedKeys(currentKey) })
  seed(source, FROM_BACKUP)
  const archive = join(root, `backup-${serial}.kfb`)
  await createBackup({ dataDir: sourceDir, dest: archive, snapshot: (path) => snapshotInto(source.db, path), version: '0.4.0', now: () => 1_794_000_000_000 })
  source.db.close()

  const keyStore = recordingKeyStore()
  if (keptKey !== null) keyStore.set(DB_KEY_REF, keptKey)
  const target = openStore(dataDir, { keys: fixedKeys(keptKey) })
  seed(target, WAS_HERE)
  target.db.close()
  const staged = await stageSnapshot({ dataDir, archivePath: archive, header: inspectBackup(archive), key: currentKey })
  await applyRestore({ dataDir, staged, keyStore, log: () => {}, sleep: noSleep })
  return { dataDir, keyStore, currentKey, keptKey }
}

function undo(pair: Pair, options: { faultAt?: UndoFaultPoint; keyStore?: RecordingKeyStore | null } = {}): Promise<{ lines: string[] }> {
  return applyUndo({
    dataDir: pair.dataDir,
    keyStore: options.keyStore === undefined ? pair.keyStore : options.keyStore,
    log: () => {},
    sleep: noSleep,
    now: () => NOW,
    ...(options.faultAt !== undefined ? { faultAt: options.faultAt } : {}),
  })
}

async function refusal(run: () => Promise<unknown> | unknown): Promise<{ kind: BackupErrorKind | 'none'; message: string }> {
  try {
    await run()
  } catch (error: unknown) {
    if (error instanceof BackupError) return { kind: error.kind, message: error.message }
    throw error
  }
  return { kind: 'none', message: '' }
}

/** The titles in memory.db, opened the way the daemon opens it: through the key store. */
function titles(pair: Pair): string[] {
  const store = openStore(pair.dataDir, { keys: dbKeyStoreOf(pair.keyStore) })
  try {
    return store.db.query<{ title: string }, []>('SELECT title FROM observations ORDER BY id').all().map((row) => row.title)
  } finally {
    store.db.close()
  }
}

/** The titles in the kept store, opened with db-key-replaced when it is encrypted. */
function keptTitles(pair: Pair, kind: Kind): string[] {
  const path = replacedPath(join(pair.dataDir, DB_FILE))
  const db = kind === 'encrypted' ? openEncrypted(path, pair.keyStore.values.get(DB_KEY_REPLACED_REF)!, { readonly: true }) : openPlain(path, { create: false })
  try {
    return db.query<{ title: string }, []>('SELECT title FROM observations ORDER BY id').all().map((row) => row.title)
  } finally {
    db.close()
  }
}

function world(pair: Pair): { tree: Record<string, { mode: number; sha: string | null }>; keys: [string, string][] } {
  const tree = Object.fromEntries(Object.entries(snapshotTree(pair.dataDir)).map(([path, entry]) => [path, { mode: entry.mode, sha: entry.sha }]))
  return { tree, keys: [...pair.keyStore.values].sort() }
}

function expectNoLeftovers(pair: Pair): void {
  const db = join(pair.dataDir, DB_FILE)
  expect(existsSync(maintenancePath(db))).toBe(false)
  expect(existsSync(asidePath(db))).toBe(false)
  expect(pair.keyStore.values.has(DB_KEY_NEXT_REF)).toBe(false)
}

/**
 * What must hold once an undo has ended either way: nothing half-done, db-key
 * opens memory.db, and the kept store opens with db-key-replaced (or with no
 * key when it is plaintext, and then there is no such entry).
 */
function expectSettled(pair: Pair, current: Kind, kept: Kind, end: 'finished' | 'undone'): void {
  expectNoLeftovers(pair)
  const db = join(pair.dataDir, DB_FILE)
  const switched = end === 'finished'
  const [inUse, aside] = switched ? [kept, current] : [current, kept]
  expect(fileState(db)).toBe(inUse)
  expect(fileState(replacedPath(db))).toBe(aside)
  expect(titles(pair)).toEqual([switched ? WAS_HERE : FROM_BACKUP])
  expect(keptTitles(pair, aside)).toEqual([switched ? FROM_BACKUP : WAS_HERE])
  expect(pair.keyStore.values.get(DB_KEY_REF) ?? null).toBe(switched ? pair.keptKey : pair.currentKey)
  expect(pair.keyStore.values.get(DB_KEY_REPLACED_REF) ?? null).toBe(switched ? pair.currentKey : pair.keptKey)
}

describe('an undo that succeeds', () => {
  for (const current of KINDS) {
    for (const kept of KINDS) {
      test(`${current} in use, ${kept} kept: the two stores and their keys change places`, async () => {
        const pair = await makePair(current, kept)
        const { lines } = await undo(pair)
        expectSettled(pair, current, kept, 'finished')
        const text = lines.join('\n')
        expect(text).toContain('switched back')
        expect(text).toContain(replacedPath(join(pair.dataDir, DB_FILE)))
        expect(text).toContain('kinfold restore --undo')
        for (const key of [pair.currentKey, pair.keptKey]) if (key !== null) expect(text).not.toContain(key)
      })
    }
  }

  test('an undo can itself be undone', async () => {
    const pair = await makePair('encrypted', 'encrypted')
    await undo(pair)
    await undo(pair)
    expectSettled(pair, 'encrypted', 'encrypted', 'undone')
  })

  test('two stores under the same key change places', async () => {
    const pair = await makePair('encrypted', 'encrypted', true)
    await undo(pair)
    expectSettled(pair, 'encrypted', 'encrypted', 'finished')
  })

  test('the store put aside is stamped with the time it was replaced', async () => {
    const pair = await makePair('encrypted', 'plain')
    await undo(pair)
    expect(keptStore(pair.dataDir)).toEqual({ path: replacedPath(join(pair.dataDir, DB_FILE)), replacedAt: NOW })
    expect(statSync(replacedPath(join(pair.dataDir, DB_FILE))).mtimeMs).toBe(NOW)
  })

  test('the steps are reported in order', async () => {
    const pair = await makePair('plain', 'plain')
    const steps: string[] = []
    await applyUndo({ dataDir: pair.dataDir, keyStore: pair.keyStore, log: () => {}, sleep: noSleep, onStep: (step) => steps.push(step) })
    expect(steps).toEqual(['close', 'swap'])
  })
})

describe('a kept store', () => {
  test('is reported with the time it was replaced, and absent when there is none', async () => {
    const pair = await makePair('encrypted', 'encrypted')
    const kept = keptStore(pair.dataDir)
    expect(kept?.path).toBe(replacedPath(join(pair.dataDir, DB_FILE)))
    expect(Math.abs((kept?.replacedAt ?? 0) - Date.now())).toBeLessThan(60_000)
    rmSync(kept!.path)
    expect(keptStore(pair.dataDir)).toBeNull()
  })
})

describe('an undo that is refused changes nothing', () => {
  async function expectRefused(pair: Pair, kind: BackupErrorKind, says: string, keyStore?: RecordingKeyStore | null): Promise<void> {
    const before = world(pair)
    const checked = await refusal(() => checkUndo({ dataDir: pair.dataDir, keyStore: keyStore === undefined ? pair.keyStore : keyStore }))
    const applied = await refusal(() => undo(pair, keyStore === undefined ? {} : { keyStore }))
    for (const answer of [checked, applied]) {
      expect(answer.kind).toBe(kind)
      expect(answer.message).toContain(says)
      for (const key of [pair.currentKey, pair.keptKey]) if (key !== null) expect(answer.message).not.toContain(key)
    }
    expect(world(pair)).toEqual(before)
  }

  test('no kept store: there is nothing to switch back to', async () => {
    const pair = await makePair('encrypted', 'encrypted')
    rmSync(replacedPath(join(pair.dataDir, DB_FILE)))
    await expectRefused(pair, 'state', 'nothing to switch back to')
  })

  test('an encrypted kept store with no db-key-replaced: there is nothing to switch back to', async () => {
    const pair = await makePair('plain', 'encrypted')
    pair.keyStore.delete(DB_KEY_REPLACED_REF)
    await expectRefused(pair, 'state', 'nothing to switch back to')
  })

  test('an encrypted kept store and no key store at all: there is nothing to switch back to', async () => {
    const pair = await makePair('plain', 'encrypted')
    await expectRefused(pair, 'state', 'nothing to switch back to', null)
  })

  test("the kept store's key does not open it", async () => {
    const pair = await makePair('encrypted', 'encrypted')
    pair.keyStore.set(DB_KEY_REPLACED_REF, newDbKey())
    pair.keptKey = pair.keyStore.values.get(DB_KEY_REPLACED_REF)!
    await expectRefused(pair, 'key-store', 'does not open')
  })

  test('a kept plaintext store that does not open', async () => {
    const pair = await makePair('encrypted', 'plain')
    const path = replacedPath(join(pair.dataDir, DB_FILE))
    writeFileSync(path, Buffer.concat([readFileSync(path).subarray(0, 100), Buffer.alloc(4096, 7)]))
    await expectRefused(pair, 'state', 'does not open')
  })

  test('a backup, restore or conversion is running or was cut short', async () => {
    const pair = await makePair('encrypted', 'encrypted')
    writeFileSync(maintenancePath(join(pair.dataDir, DB_FILE)), '{"op":"encrypt","pid":1}\n')
    await expectRefused(pair, 'busy', 'kinfold key resume')
  })

  test('the store in use has no key that opens it, so it could not be kept', async () => {
    const pair = await makePair('encrypted', 'encrypted')
    pair.keyStore.set(DB_KEY_REF, newDbKey())
    pair.currentKey = pair.keyStore.values.get(DB_KEY_REF)!
    await expectRefused(pair, 'key-store', 'kinfold key recover')
  })

  test('there is no store in use to switch from', async () => {
    const pair = await makePair('plain', 'plain')
    rmSync(join(pair.dataDir, DB_FILE))
    await expectRefused(pair, 'state', 'no memory.db')
  })

  test('db-key-replaced holds the key of some other store beside a plaintext kept store', async () => {
    const pair = await makePair('encrypted', 'plain')
    pair.keyStore.set(DB_KEY_REPLACED_REF, newDbKey())
    await expectRefused(pair, 'state', DB_KEY_REPLACED_REF)
  })

  test('a db-key-next left by a rekey that was cut short: settle that first', async () => {
    const pair = await makePair('encrypted', 'encrypted')
    pair.keyStore.set(DB_KEY_NEXT_REF, newDbKey())
    await expectRefused(pair, 'state', 'kinfold key resume')
  })

  test('a store put aside by a run that was cut short is still here', async () => {
    const pair = await makePair('plain', 'plain')
    writeFileSync(asidePath(join(pair.dataDir, DB_FILE)), 'left behind')
    await expectRefused(pair, 'state', 'cut short')
  })
})

describe('an undo cut short is finished or rolled back by resume', () => {
  const ENDS: Readonly<Record<UndoFaultPoint, 'undone' | 'finished'>> = {
    'after-journal': 'undone',
    'after-keys': 'undone',
    'after-move-aside': 'undone',
    'after-move-in': 'finished',
    'after-phase': 'finished',
    'after-key-swap': 'finished',
    'after-keep': 'finished',
  }

  test('every fault point has an ending', () => {
    expect(Object.keys(ENDS).sort()).toEqual([...UNDO_FAULT_POINTS].sort())
  })

  for (const current of KINDS) {
    for (const kept of KINDS) {
      const name = `${current} in use, ${kept} kept`
      for (const point of UNDO_FAULT_POINTS) {
        test(`${name}, killed ${point}: ${ENDS[point]}`, async () => {
          const pair = await makePair(current, kept)
          await expect(undo(pair, { faultAt: point })).rejects.toBeInstanceOf(UndoCrash)
          const marker = maintenancePath(join(pair.dataDir, DB_FILE))
          expect(existsSync(marker)).toBe(true)
          expect(readUndoJournal(join(pair.dataDir, DB_FILE))?.op).toBe('restore-undo')
          const keys = [pair.currentKey, pair.keptKey].filter((key): key is string => key !== null)
          for (const key of keys) expect(readFileSync(marker, 'utf8')).not.toContain(key)
          // The marker keeps a second run out until resume has settled the first.
          expect((await refusal(() => undo(pair))).kind).toBe('busy')

          const lines: string[] = []
          expect(resumeUndo({ dataDir: pair.dataDir, keyStore: pair.keyStore, log: (line) => lines.push(line) })).toBe(ENDS[point])
          expectSettled(pair, current, kept, ENDS[point])
          expect(lines.length).toBeGreaterThan(0)
          for (const line of lines) for (const key of keys) expect(line).not.toContain(key)
        })

        test(`${name}, killed ${point}, then resume killed too: a second resume ends the same way`, async () => {
          const pair = await makePair(current, kept)
          await expect(undo(pair, { faultAt: point })).rejects.toBeInstanceOf(UndoCrash)
          // A resume that dies after settling the files but before the marker is gone leaves the marker; put it back to stand for that.
          const marker = maintenancePath(join(pair.dataDir, DB_FILE))
          const journal = readFileSync(marker, 'utf8')
          const end = resumeUndo({ dataDir: pair.dataDir, keyStore: pair.keyStore, log: () => {} })
          expect(readUndoJournal(join(pair.dataDir, DB_FILE))).toBeNull()
          writeFileSync(marker, end === 'finished' && !journal.includes('"phase"') ? journal.replace('}', ',"phase":"swapped"}') : journal)
          expect(resumeUndo({ dataDir: pair.dataDir, keyStore: pair.keyStore, log: () => {} })).toBe(end)
          expectSettled(pair, current, kept, end)
        })
      }

      // The key store refusing one write, at each place the run writes: the run rolls itself
      // back, finishes, or leaves the marker for resume, and every ending is two working stores.
      const WRITES = [['set', DB_KEY_NEXT_REF], ['set', DB_KEY_REPLACED_REF], ['set', DB_KEY_REF], ['delete', DB_KEY_NEXT_REF], ['delete', DB_KEY_REF], ['delete', DB_KEY_REPLACED_REF]] as const
      for (const [method, ref] of WRITES) {
        test(`${name}, the key store failing one ${method} of ${ref}`, async () => {
          const pair = await makePair(current, kept)
          const original = pair.keyStore[method].bind(pair.keyStore) as (account: string, value: string) => unknown
          let armed = true
          const failing = (account: string, value: string): unknown => {
            if (armed && account === ref) {
              armed = false
              throw new Error('the key store is locked')
            }
            return original(account, value)
          }
          Object.assign(pair.keyStore, { [method]: failing })
          let end: 'undone' | 'finished'
          try {
            await undo(pair)
            end = 'finished'
          } catch (error: unknown) {
            end = error instanceof RestoreStranded ? resumeUndo({ dataDir: pair.dataDir, keyStore: pair.keyStore, log: () => {} }) : 'undone'
          }
          expectSettled(pair, current, kept, end)
        })
      }
    }
  }

  test('a db-key-next that does not open the kept store is never copied over its key', async () => {
    // Killed before this run wrote db-key-next; later steps put the kept key there, and it is then the only copy.
    for (const point of ['after-journal'] as const) {
      const pair = await makePair('encrypted', 'encrypted')
      await expect(undo(pair, { faultAt: point })).rejects.toBeInstanceOf(UndoCrash)
      // Something else wrote db-key-next while the run was stopped (a rekey started and was cut short, say).
      const stray = newDbKey()
      pair.keyStore.set(DB_KEY_NEXT_REF, stray)
      expect(resumeUndo({ dataDir: pair.dataDir, keyStore: pair.keyStore, log: () => {} })).toBe('undone')
      expect(pair.keyStore.values.get(DB_KEY_REPLACED_REF)).toBe(pair.keptKey!)
      expect(keptTitles(pair, 'encrypted')).toEqual([WAS_HERE])
      expect(titles(pair)).toEqual([FROM_BACKUP])
      // The entry this run did not write is left for whatever wrote it.
      expect(pair.keyStore.values.get(DB_KEY_NEXT_REF)).toBe(stray)
    }
  })

  test('a switch that gives up waiting for the store leaves both keys where they were', async () => {
    const pair = await makePair('encrypted', 'encrypted')
    // The daemon keeps the store in WAL mode; a reader on it is what an agent's MCP server leaves open.
    const wal = openEncrypted(join(pair.dataDir, DB_FILE), pair.currentKey!)
    wal.query('PRAGMA journal_mode = WAL').get()
    wal.close()
    const holder = openEncrypted(join(pair.dataDir, DB_FILE), pair.currentKey!)
    holder.query('BEGIN').run()
    holder.query('SELECT count(*) FROM observations').get()
    try {
      const answer = await refusal(() => applyUndo({ dataDir: pair.dataDir, keyStore: pair.keyStore, log: () => {}, sleep: noSleep, lockAttempts: 1 }))
      expect(answer.kind).toBe('busy')
    } finally {
      holder.query('ROLLBACK').run()
      holder.close()
    }
    expectSettled(pair, 'encrypted', 'encrypted', 'undone')
  })

  test('resume with no undo journal says so and changes nothing', async () => {
    const pair = await makePair('encrypted', 'encrypted')
    const before = world(pair)
    expect(() => resumeUndo({ dataDir: pair.dataDir, keyStore: pair.keyStore, log: () => {} })).toThrow(BackupError)
    expect(world(pair)).toEqual(before)
  })

  test('a store that opens with no key it can find is left alone, with the marker', async () => {
    const pair = await makePair('encrypted', 'encrypted')
    await expect(undo(pair, { faultAt: 'after-move-in' })).rejects.toBeInstanceOf(UndoCrash)
    pair.keyStore.delete(DB_KEY_NEXT_REF)
    // Everything but the marker, which resume may rewrite with the phase it found.
    const stores = (): unknown => {
      const { tree, keys } = world(pair)
      return { keys, tree: Object.fromEntries(Object.entries(tree).filter(([path]) => path !== MAINTENANCE_FILE)) }
    }
    const before = stores()
    expect(() => resumeUndo({ dataDir: pair.dataDir, keyStore: pair.keyStore, log: () => {} })).toThrow(BackupError)
    // Nothing is deleted or moved: both stores are where the run left them, and the marker stays for a later resume.
    expect(stores()).toEqual(before)
    expect(existsSync(maintenancePath(join(pair.dataDir, DB_FILE)))).toBe(true)
  })
})
