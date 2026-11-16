// Switching back to the store a restore replaced (`kinfold restore --undo`).
// A restore that replaced a store with memory keeps it beside the restored
// one as memory.db.kinfold-replaced, with its key under db-key-replaced. Undo
// makes the two change places, files and keys, with no recovery code: both
// keys are already in the key store. What was in use becomes the kept pair,
// so an undo can itself be undone.
//
// The order keeps every store openable at every moment:
//
//   journal the maintenance marker is written (op restore-undo): hooks and
//           MCP servers stay off memory.db, and `kinfold key resume` can
//           read how far a killed run got.
//   keys    the kept store's key is copied to db-key-next, and only then
//           does db-key-replaced take the key of the store in use. Each is
//           read back. db-key is untouched, so it still opens memory.db.
//   swap    memory.db is renamed aside, the kept store renamed into place,
//           and the journal is rewritten with phase "swapped".
//   finish  db-key takes the key from db-key-next, and the store put aside
//           becomes memory.db.kinfold-replaced.
//
// Until the kept store is in place the run can be rolled back; from then on
// it can only be finished. settle() decides which from the files on disk and
// the journal's phase, for a failure inside the run and for resume alike.
// Nothing is ever deleted but a key entry whose value sits in another entry.

import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DB_KEY_NEXT_REF, DB_KEY_REF, DB_KEY_REPLACED_REF } from '../secrets/credentials'
import type { KeyStore } from '../secrets/key-store'
import { foundBackupPath } from '../sqlite/convert'
import { fileState, maintenancePath } from '../sqlite/open'
import { DB_FILE } from '../store/data-dir'
import { BackupError } from './archive'
import { type StoreKind, type UndoJournal, readUndoJournal, writeUndoJournal } from './journal'
import { type RestoreOutcome, type RestoreStep, type ResumeInput, RestoreStranded, SIDE_FILES, asidePath, opens, replacedPath, stampReplaced, storeKey, takeExclusive } from './restore'

export const UNDO_FAULT_POINTS = ['after-journal', 'after-keys', 'after-move-aside', 'after-move-in', 'after-phase', 'after-key-swap', 'after-keep'] as const
export type UndoFaultPoint = (typeof UNDO_FAULT_POINTS)[number]

/** Test seam: stands for the process being killed at a point, so nothing after it runs, the rollback included. */
export class UndoCrash extends Error {
  constructor(readonly point: UndoFaultPoint) {
    super(`undo stopped ${point}`)
    this.name = 'UndoCrash'
  }
}

export interface UndoInput {
  dataDir: string
  /** null: this platform has no key store, so only plaintext stores can change places. */
  keyStore: KeyStore | null
  log: (line: string) => void
  sleep: (ms: number) => Promise<void>
  onStep?: (step: RestoreStep) => void
  lockAttempts?: number
  faultAt?: UndoFaultPoint
  now?: () => number
}

export interface KeptStore {
  path: string
  /** When the store was replaced: the time the file was put aside. */
  replacedAt: number
}

/** The store a restore kept, if one is here. Reads only. */
export function keptStore(dataDir: string): KeptStore | null {
  const path = replacedPath(join(dataDir, DB_FILE))
  try {
    if (fileState(path) === 'new') return null
    return { path, replacedAt: statSync(path).mtimeMs }
  } catch {
    return null
  }
}

interface Plan {
  dbPath: string
  kept: KeptStore
  currentKey: string | null
  keptKey: string | null
}

/** Everything that can refuse an undo before it starts. Changes nothing. */
export function checkUndo(input: Pick<UndoInput, 'dataDir' | 'keyStore'>): Plan {
  const dbPath = join(input.dataDir, DB_FILE)
  const place = input.keyStore?.place ?? 'the key store'
  if (existsSync(maintenancePath(dbPath))) throw new BackupError('busy', 'a kinfold encrypt, decrypt, rekey or restore is running or was cut short; if none is running, run kinfold key resume')
  if (existsSync(foundBackupPath(dbPath))) throw new BackupError('state', `${foundBackupPath(dbPath)} is left from a conversion that was cut short; run kinfold key resume first`)
  if (existsSync(asidePath(dbPath))) throw new BackupError('state', `${asidePath(dbPath)} is left from a restore that was cut short; it is a store that was in use here. Move it away, then run this again`)
  // db-key-next is the one slot that carries a key between two entries. One already there belongs to a rekey
  // or restore that was cut short, and this run would write over it, or later take it for the kept store's key.
  if (input.keyStore?.exists(DB_KEY_NEXT_REF) === true) {
    throw new BackupError('state', `${input.keyStore.place} holds ${DB_KEY_NEXT_REF}, left by a kinfold rekey or restore that was cut short; run kinfold key resume first. Nothing was changed`)
  }
  const kept = keptStore(input.dataDir)
  if (kept === null) throw new BackupError('state', 'there is nothing to switch back to: no restore has kept a store here. Nothing was changed')
  const keptKind: StoreKind = fileState(kept.path) === 'encrypted' ? 'encrypted' : 'plain'
  const keptKey = keptKind === 'encrypted' ? (input.keyStore?.get(DB_KEY_REPLACED_REF) ?? null) : null
  if (keptKind === 'encrypted' && keptKey === null) {
    throw new BackupError('state', `there is nothing to switch back to: ${kept.path} is kept, but ${place} has no ${DB_KEY_REPLACED_REF}, the key that opens it. Nothing was changed`)
  }
  if (!opens(kept.path, keptKey)) {
    throw keptKind === 'encrypted'
      ? new BackupError('key-store', `the key kept as ${DB_KEY_REPLACED_REF} does not open ${kept.path}. Nothing was changed`)
      : new BackupError('state', `${kept.path} does not open as a Kinfold store. Nothing was changed`)
  }
  const state = fileState(dbPath)
  if (state === 'new') throw new BackupError('state', `there is no memory.db here to switch from. To use the kept store, stop Kinfold and move ${kept.path} to ${dbPath}. Nothing was changed`)
  const currentKey = state === 'encrypted' ? (input.keyStore?.get(DB_KEY_REF) ?? null) : null
  // The store in use becomes the kept one, and a kept store must have a key that opens it.
  if ((state === 'encrypted' && currentKey === null) || !opens(dbPath, currentKey)) {
    throw new BackupError('key-store', `memory.db here does not open with the key in ${place}, so it could not be kept. Run kinfold key recover first. Nothing was changed`)
  }
  // db-key-replaced has one slot. Beside a plaintext kept store, an entry there belongs to some
  // other store (one an earlier restore kept and someone has since moved): it is not written over.
  const stray = keptKind === 'plain' ? (input.keyStore?.get(DB_KEY_REPLACED_REF) ?? null) : null
  if (stray !== null && stray !== currentKey) {
    const entry = input.keyStore?.describeEntry(DB_KEY_REPLACED_REF) ?? DB_KEY_REPLACED_REF
    throw new BackupError('state', `${place} holds ${DB_KEY_REPLACED_REF}, the key of a store an earlier restore kept, and it is not the key of ${kept.path}. If you no longer need that store, delete ${entry}, then run this again. Nothing was changed`)
  }
  return { dbPath, kept, currentKey, keptKey }
}

interface Paths {
  dbPath: string
  aside: string
  replaced: string
  marker: string
}

function pathsOf(dataDir: string): Paths {
  const dbPath = join(dataDir, DB_FILE)
  return { dbPath, aside: asidePath(dbPath), replaced: replacedPath(dbPath), marker: maintenancePath(dbPath) }
}

const stranded = (): BackupError => new BackupError('state', 'a store here opens with no key that could be found; nothing was deleted. Run kinfold key recover with your recovery code')

/**
 * With the kept store in place: db-key takes its key, the store put aside
 * becomes the kept one, the marker goes. Every step can run again. The store
 * is proved to open before any file is renamed, so a key that went missing
 * leaves both files where they are.
 */
function finish(dataDir: string, keyStore: KeyStore | null, journal: UndoJournal, now: number, fault: (point: UndoFaultPoint) => void = () => {}): void {
  const paths = pathsOf(dataDir)
  if (journal.kept === 'encrypted') {
    const next = keyStore?.get(DB_KEY_NEXT_REF) ?? null
    if (keyStore !== null && next !== null) {
      storeKey(keyStore, DB_KEY_REF, next)
      keyStore.delete(DB_KEY_NEXT_REF)
    }
  } else if (keyStore !== null && keyStore.exists(DB_KEY_REF)) {
    // A plaintext store beside a database key reads as a conversion that failed. The key is not lost: it went to db-key-replaced before any file moved.
    keyStore.delete(DB_KEY_REF)
  }
  const key = journal.kept === 'encrypted' ? (keyStore?.get(DB_KEY_REF) ?? null) : null
  if ((journal.kept === 'encrypted' && key === null) || !opens(paths.dbPath, key)) throw stranded()
  fault('after-key-swap')
  if (existsSync(paths.aside)) {
    stampReplaced(paths.aside, now)
    renameSync(paths.aside, paths.replaced)
  }
  fault('after-keep')
  rmSync(paths.marker, { force: true })
}

/** Before the kept store is in place: the store in use goes back under its name, and the key entries back to what they held. */
function rollBack(dataDir: string, keyStore: KeyStore | null, journal: UndoJournal): void {
  const paths = pathsOf(dataDir)
  const movedAside = existsSync(paths.aside)
  // db-key is untouched until the kept store is in place, so it still opens the store that was in use.
  const currentKey = journal.current === 'encrypted' ? (keyStore?.get(DB_KEY_REF) ?? null) : null
  if ((journal.current === 'encrypted' && currentKey === null) || !opens(movedAside ? paths.aside : paths.dbPath, currentKey)) throw stranded()
  if (movedAside) renameSync(paths.aside, paths.dbPath)
  if (keyStore !== null) {
    const next = keyStore.get(DB_KEY_NEXT_REF)
    if (journal.kept === 'encrypted') {
      // db-key-next goes back only when it is the kept store's key, so a value something else left there never takes its place.
      if (next !== null && opens(paths.replaced, next)) {
        storeKey(keyStore, DB_KEY_REPLACED_REF, next)
        keyStore.delete(DB_KEY_NEXT_REF)
      }
    } else if (currentKey !== null && keyStore.get(DB_KEY_REPLACED_REF) === currentKey) {
      // Only the copy this run made: beside a plaintext kept store there was no such entry.
      keyStore.delete(DB_KEY_REPLACED_REF)
    }
  }
  rmSync(paths.marker, { force: true })
}

/** Finishes the run when the kept store is already in place, and rolls it back otherwise. */
function settle(dataDir: string, keyStore: KeyStore | null, journal: UndoJournal, now: number): 'finished' | 'undone' {
  const paths = pathsOf(dataDir)
  const movedIn = journal.phase === 'swapped' || (existsSync(paths.aside) && !existsSync(paths.replaced) && fileState(paths.dbPath) !== 'new')
  if (movedIn) {
    // Once the store put aside is renamed, the files alone look like a run that never started; the phase is what says it did.
    if (journal.phase !== 'swapped') writeUndoJournal(paths.dbPath, { ...journal, phase: 'swapped' })
    finish(dataDir, keyStore, journal, now)
    return 'finished'
  }
  rollBack(dataDir, keyStore, journal)
  return 'undone'
}

function outcomeLines(input: UndoInput, plan: Plan): string[] {
  const keyNote = plan.currentKey === null ? '' : `, and its key is in ${input.keyStore?.place ?? 'the key store'} as ${DB_KEY_REPLACED_REF}`
  return [
    `switched back to the store that was replaced on ${new Date(plan.kept.replacedAt).toISOString()}`,
    `the store that was in use is kept as ${replacedPath(plan.dbPath)}${keyNote}`,
    'to switch to it again: kinfold restore --undo',
  ]
}

/**
 * Makes the kept store and the store in use change places. The caller has
 * closed its own connections to memory.db. Resolves once the marker is gone;
 * rejects with the reason after putting everything back, or with
 * RestoreStranded when that failed too and the marker is left.
 */
export async function applyUndo(input: UndoInput): Promise<RestoreOutcome> {
  const plan = checkUndo(input)
  const { dbPath } = plan
  const now = (input.now ?? Date.now)()
  const journal: UndoJournal = {
    op: 'restore-undo',
    pid: process.pid,
    startedAt: now,
    current: plan.currentKey === null ? 'plain' : 'encrypted',
    kept: plan.keptKey === null ? 'plain' : 'encrypted',
  }
  const fault = (point: UndoFaultPoint): void => {
    if (input.faultAt === point) throw new UndoCrash(point)
  }
  writeUndoJournal(dbPath, journal)
  try {
    fault('after-journal')
    input.onStep?.('close')
    await takeExclusive({ dbPath, oldKey: plan.currentKey }, input, 'run kinfold restore --undo again')
    // The kept key gets its second copy first, so db-key-replaced can be written over.
    if (plan.keptKey !== null) storeKey(input.keyStore!, DB_KEY_NEXT_REF, plan.keptKey)
    if (plan.currentKey !== null) storeKey(input.keyStore!, DB_KEY_REPLACED_REF, plan.currentKey)
    else if (input.keyStore !== null && input.keyStore.exists(DB_KEY_REPLACED_REF)) input.keyStore.delete(DB_KEY_REPLACED_REF)
    fault('after-keys')
    input.onStep?.('swap')
    for (const suffix of SIDE_FILES) rmSync(`${dbPath}${suffix}`, { force: true })
    renameSync(dbPath, asidePath(dbPath))
    fault('after-move-aside')
    renameSync(plan.kept.path, dbPath)
    fault('after-move-in')
    writeUndoJournal(dbPath, { ...journal, phase: 'swapped' })
    fault('after-phase')
    finish(input.dataDir, input.keyStore, journal, now, fault)
  } catch (error: unknown) {
    if (error instanceof UndoCrash) throw error
    let end: 'finished' | 'undone'
    try {
      end = settle(input.dataDir, input.keyStore, readUndoJournal(dbPath) ?? journal, now)
    } catch {
      writeUndoJournal(dbPath, { ...(readUndoJournal(dbPath) ?? journal), abandoned: true })
      throw new RestoreStranded('switching back failed partway and could not be put right; nothing was deleted. Run kinfold key resume')
    }
    if (end === 'undone') {
      throw error instanceof BackupError ? error : new BackupError('state', `switching back failed (${error instanceof Error ? error.name : 'error'}); the store that was in use is back as it was`)
    }
  }
  return { lines: outcomeLines(input, plan) }
}

/** `kinfold key resume` for an undo: finishes it or rolls it back from what is on disk. Throws when the marker is not an undo's, or when neither can be done (nothing is deleted then). */
export function resumeUndo(input: ResumeInput & { now?: () => number }): 'finished' | 'undone' {
  const dbPath = join(input.dataDir, DB_FILE)
  const journal = readUndoJournal(dbPath)
  if (journal === null) throw new BackupError('state', 'no kinfold restore --undo was cut short')
  const end = settle(input.dataDir, input.keyStore, journal, (input.now ?? Date.now)())
  input.log(end === 'finished'
    ? `the switch back had put the kept store in place; it is finished now, and the store that was in use is kept as ${replacedPath(dbPath)}`
    : 'the switch back had not replaced memory.db; the store that was in use is back as it was. Run kinfold restore --undo again to switch back')
  return end
}
