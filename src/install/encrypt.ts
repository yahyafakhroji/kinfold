// `kinfold encrypt | decrypt | rekey | key show-recovery | key recover | key resume`
// The database part is src/sqlite/convert.ts; this file
// orders the rest so no step can strand the store without its key:
//   - a new key goes into the Keychain, and is read back, before the store
//     changes (rekey writes db-key-next, and moves it to db-key only once the
//     converted store checks out);
//   - encrypt and rekey show the recovery code first, and go on only once the
//     person types its last two groups back;
//   - the LaunchAgent's daemon is stopped and started again around the change,
//     a hand-started one makes the command refuse, and the maintenance marker
//     keeps hooks and MCP servers off the file meanwhile;
//   - the marker is also the journal: it names the operation and the Keychain
//     entry that opens the result, so `kinfold key resume` can finish or undo a run
//     that was killed, from what is on disk (a backup left behind is always the
//     original);
//   - SIGINT, SIGTERM and SIGHUP wait while the store is being changed.
// The key is never printed; the recovery code is printed only here, on request.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CredentialProvider, DB_KEY_NEXT_REF, DB_KEY_REF } from '../secrets/credentials'
import { createKeychainProvider } from '../secrets/keychain'
import { type CredentialWriter, credentialWriterFor } from '../secrets/keychain-writer'
import { ConvertError, checkedCounts, convertStore, foundBackupPath, restoreBackup, sameCounts } from '../sqlite/convert'
import { type DbKeyStore, credentialDbKeyStore, newDbKey } from '../sqlite/keys'
import { fileState, maintenancePath, openEncrypted } from '../sqlite/open'
import { RECOVERY_GROUP, RecoveryCodeError, decodeRecoveryCode, encodeRecoveryCode } from '../sqlite/recovery'
import { DATA_FILE_MODE, DB_FILE } from '../store/data-dir'
import { waitForHealth } from './daemon-client'
import { type InstallEnv, errorMessage } from './env'
import { EXIT_FAILED, EXIT_OK } from './install'
import { HEALTH_WAIT_MS } from './plan'
import { serviceOf } from './service/control'

export const KEY_COMMANDS = ['encrypt', 'decrypt', 'rekey', 'show-recovery', 'recover', 'resume'] as const
export type KeyCommand = (typeof KEY_COMMANDS)[number]

/** MCP servers close an idle reader after READER_TTL_MS (30 s); the marker stops them reopening, so a few seconds past that the file is free. */
export const LOCK_ATTEMPTS = 36
export const LOCK_RETRY_MS = 1_000
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

class Refusal extends Error {}

type Op = 'encrypt' | 'decrypt' | 'rekey'

/** What the marker records: enough for `kinfold key resume` to tell how a killed run ended. */
export interface Journal {
  op: Op
  pid: number
  startedAt: number
  /** The Keychain entry whose key opens the store before the change; null: plaintext. */
  source: string | null
  /** The entry whose key opens it after; null: plaintext. */
  target: string | null
}

interface Context {
  env: InstallEnv
  path: string
  writer: CredentialWriter
  keychain: CredentialProvider
  keys: DbKeyStore
  log: (line: string) => void
}

function context(env: InstallEnv): Context {
  const writer = credentialWriterFor(env.platform, env.security)
  if (writer === null) throw new Refusal(`encryption needs the macOS Keychain; ${env.platform} gets its key store in a later release`)
  const keychain = createKeychainProvider((args) => env.security({ args }))
  return { env, path: join(env.dataDir, DB_FILE), writer, keychain, keys: credentialDbKeyStore('keychain', keychain, () => writer.exists(DB_KEY_REF)), log: env.out }
}

/** Writes the key and reads it back; the read is the same `security -w` a hook makes, so a Keychain prompt would show here first. */
function storeKey(ctx: Context, ref: string, key: string): void {
  ctx.writer.put(ref, key)
  if (ctx.keychain.get(ref) !== key) throw new Refusal(`the Keychain entry ${ref} did not read back; nothing was converted`)
}

function keyAt(ctx: Context, ref: string | null): string | null {
  if (ref === null) return null
  const key = ctx.keychain.get(ref)
  if (key === null) throw new Refusal(`the Keychain has no ${ref}`)
  return key
}

const normalize = (text: string): string => text.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')

/** Prints the code and waits for its last two groups; false when the person typed something else. */
async function confirmCode(ctx: Context, code: string): Promise<boolean> {
  ctx.log('')
  ctx.log('Recovery code for memory.db. Write it down or put it in a password manager, away from this machine:')
  ctx.log('')
  ctx.log(`    ${code}`)
  ctx.log('')
  ctx.log('Without the key or this code, the memory cannot be read again. Anyone with the code can read it.')
  const tail = code.split('-').slice(-2).join('')
  const typed = await ctx.env.io.ask(`Type the last two groups (${'*'.repeat(RECOVERY_GROUP)}-${'*'.repeat(RECOVERY_GROUP)}) to confirm you saved it: `)
  return normalize(typed) === tail
}

interface Daemon {
  restart: boolean
}

async function startDaemon(ctx: Context, daemon: Daemon): Promise<void> {
  const service = serviceOf(ctx.env)
  if (!daemon.restart || service === null) {
    ctx.log('daemon: it was not running as a service; start it when you are ready')
    return
  }
  try {
    await service.start()
  } catch (error: unknown) {
    ctx.log(`warning: the ${service.label} did not start (${errorMessage(error)})`)
  }
  ctx.log((await waitForHealth(ctx.env, true, HEALTH_WAIT_MS)) ? 'daemon: started again' : 'warning: the daemon did not answer /health after the restart; see its log')
}

async function stopDaemon(ctx: Context): Promise<Daemon> {
  const service = serviceOf(ctx.env)
  const loaded = service !== null && (await service.isRunning())
  if (loaded) {
    await service.stop()
    ctx.log(`daemon: stopped the ${service.label}`)
  }
  if (!(await waitForHealth(ctx.env, false, HEALTH_WAIT_MS))) {
    if (loaded) await startDaemon(ctx, { restart: true })
    throw new Refusal('a daemon still answers /health (one started by hand?); stop it and run this again')
  }
  return { restart: loaded }
}

/** Who still holds memory.db, for the "another process" refusal: pids and command names only. */
async function holders(ctx: Context): Promise<string> {
  return (await serviceOf(ctx.env)?.fileHolders(ctx.path)) ?? ''
}

/** Retries while another process holds the file: agent sessions let go of an idle reader within 30 s and cannot reopen past the marker. */
async function convertWhenFree(ctx: Context, from: string | null, to: string | null): Promise<ReturnType<typeof convertStore>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return convertStore({ path: ctx.path, from, to, log: ctx.log })
    } catch (error: unknown) {
      if (!(error instanceof ConvertError) || error.stage !== 'lock' || attempt >= LOCK_ATTEMPTS) throw error
      if (attempt === 1) ctx.log(`waiting up to ${Math.round((LOCK_ATTEMPTS * LOCK_RETRY_MS) / 1000)} s for agent sessions to let go of memory.db; their memory tools answer "unavailable" meanwhile`)
      await ctx.env.sleep(LOCK_RETRY_MS)
    }
  }
}

// ---- What each operation does around the conversion -------------------------

/** Only once the converted store checked out. A failure here leaves the store converted: it is reported, never undone. */
function finish(ctx: Context, op: Op): void {
  if (op === 'rekey') {
    storeKey(ctx, DB_KEY_REF, keyAt(ctx, DB_KEY_NEXT_REF)!)
    ctx.writer.remove(DB_KEY_NEXT_REF)
  }
  if (op === 'decrypt') ctx.writer.remove(DB_KEY_REF)
}

/** Only when the store is as it was before: the key the run added goes again. */
function undo(ctx: Context, op: Op): void {
  if (op === 'encrypt') ctx.writer.remove(DB_KEY_REF)
  if (op === 'rekey') ctx.writer.remove(DB_KEY_NEXT_REF)
}

const STRANDED: Record<Op, string> = {
  encrypt: 'a last step failed',
  rekey: `the new key is still under ${DB_KEY_NEXT_REF}, not ${DB_KEY_REF}; run kinfold key resume`,
  decrypt: `the Keychain still holds ${DB_KEY_REF}; run kinfold key resume`,
}

function journalFor(op: Op): Journal {
  const source = op === 'encrypt' ? null : DB_KEY_REF
  const target = op === 'decrypt' ? null : op === 'rekey' ? DB_KEY_NEXT_REF : DB_KEY_REF
  return { op, pid: process.pid, startedAt: Date.now(), source, target }
}

export function readJournal(path: string): Journal | null {
  try {
    const value = JSON.parse(readFileSync(maintenancePath(path), 'utf8')) as Partial<Journal>
    const ref = (r: unknown) => r === null || r === DB_KEY_REF || r === DB_KEY_NEXT_REF
    if ((value.op === 'encrypt' || value.op === 'decrypt' || value.op === 'rekey') && typeof value.pid === 'number' && ref(value.source) && ref(value.target)) {
      return { op: value.op, pid: value.pid, startedAt: Number(value.startedAt ?? 0), source: value.source ?? null, target: value.target ?? null }
    }
  } catch {
    // Unreadable: treated as a marker from an unknown run.
  }
  return null
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Holds SIGINT, SIGTERM and SIGHUP while the store is being changed; a held signal is reported once and the run finishes. */
async function uninterrupted<T>(ctx: Context, run: () => Promise<T>): Promise<T> {
  const hold = (): void => ctx.log('the conversion is changing memory.db and cannot stop halfway; it finishes or puts the original back first')
  for (const signal of SIGNALS) process.on(signal, hold)
  try {
    return await run()
  } finally {
    for (const signal of SIGNALS) process.off(signal, hold)
  }
}

/** Stop, journal, prepare, convert, finish, unjournal, start. */
async function converting(ctx: Context, op: Op, from: string | null, to: string | null, prepare: () => void): Promise<void> {
  const daemon = await stopDaemon(ctx)
  const marker = maintenancePath(ctx.path)
  writeFileSync(marker, `${JSON.stringify(journalFor(op))}\n`, { mode: DATA_FILE_MODE })
  let keepMarker = false
  try {
    await uninterrupted(ctx, async () => {
      let result: ReturnType<typeof convertStore>
      try {
        prepare()
        result = await convertWhenFree(ctx, from, to)
      } catch (error: unknown) {
        if (error instanceof ConvertError && error.stage === 'restore') {
          // The original may be only in the backup: no key goes, and the marker stays for kinfold key resume.
          keepMarker = true
          throw error
        }
        undo(ctx, op)
        if (error instanceof ConvertError && error.stage === 'lock') {
          const held = await holders(ctx)
          throw new Refusal(`${error.message}${held === '' ? '' : `\n  held by: ${held}\n  close those agent sessions (their MCP servers keep memory.db open), then run this again`}`)
        }
        throw error
      }
      ctx.log(`converted ${result.rows} rows in ${result.tables} tables (${result.ms} ms); every count matched`)
      try {
        finish(ctx, op)
      } catch (error: unknown) {
        keepMarker = true
        throw new Refusal(`memory.db was converted, but ${STRANDED[op]} (${errorMessage(error)})`)
      }
    })
  } finally {
    if (!keepMarker) rmSync(marker, { force: true })
    await startDaemon(ctx, daemon)
  }
}

function requireNoRun(ctx: Context): void {
  if (!existsSync(maintenancePath(ctx.path))) return
  const journal = readJournal(ctx.path)
  if (journal !== null && alive(journal.pid) && journal.pid !== process.pid) throw new Refusal(`a kinfold ${journal.op} is running (pid ${journal.pid}); wait for it`)
  throw new Refusal(`a kinfold ${journal?.op ?? 'encrypt, decrypt or rekey'} was cut short; run kinfold key resume first`)
}

function requireState(ctx: Context, want: 'plain' | 'encrypted'): void {
  requireNoRun(ctx)
  if (existsSync(foundBackupPath(ctx.path))) throw new Refusal(`${foundBackupPath(ctx.path)} is left from a run that was cut short; run kinfold key resume first`)
  const state = fileState(ctx.path)
  if (state === want) return
  if (state === 'new') throw new Refusal(`${ctx.path} does not exist yet`)
  throw new Refusal(want === 'plain' ? 'memory.db is already encrypted' : 'memory.db is not encrypted; kinfold encrypt converts it')
}

function requireInteractive(ctx: Context, why: string): void {
  if (!ctx.env.io.interactive) throw new Refusal(`${why} needs a terminal`)
}

/** A recovery code is a secret: it must reach a terminal, never a pipe or a file that stdout may point at. */
function requireSecretOutput(ctx: Context, why: string): void {
  requireInteractive(ctx, why)
  if (ctx.env.io.printsToTerminal === false) throw new Refusal(`${why} needs a terminal on stdout, not a pipe or a file`)
}

function readKey(ctx: Context): string {
  const key = ctx.keys.read()
  if (key === null) throw new Refusal(`the Keychain has no ${DB_KEY_REF}; restore it with kinfold key recover`)
  return key
}

async function encrypt(ctx: Context): Promise<void> {
  requireState(ctx, 'plain')
  requireSecretOutput(ctx, 'kinfold encrypt shows a recovery code and')
  if (ctx.writer.exists(DB_KEY_REF)) {
    const typed = await ctx.env.io.ask(`The Keychain already holds ${DB_KEY_REF}, which may open an older encrypted copy of memory.db. Type replace to give this store a new key: `)
    if (typed.trim() !== 'replace') throw new Refusal(`nothing changed; ${DB_KEY_REF} is kept`)
  }
  ctx.log('kinfold encrypt converts memory.db to an encrypted file (ChaCha20-Poly1305), with its key in the Keychain.')
  ctx.log('The plaintext backup it takes is deleted afterwards, but an SSD, APFS snapshots or Time Machine may keep old blocks; full-disk encryption (FileVault) covers those.')
  const key = newDbKey()
  if (!(await confirmCode(ctx, encodeRecoveryCode(key)))) throw new Refusal('those were not the last two groups; nothing changed')
  await converting(ctx, 'encrypt', null, key, () => storeKey(ctx, DB_KEY_REF, key))
  ctx.log('memory.db is encrypted.')
}

async function rekey(ctx: Context): Promise<void> {
  requireState(ctx, 'encrypted')
  requireSecretOutput(ctx, 'kinfold rekey shows a new recovery code and')
  const old = readKey(ctx)
  const key = newDbKey()
  ctx.log('kinfold rekey gives memory.db a new key. The old key and the old recovery code stop working.')
  if (!(await confirmCode(ctx, encodeRecoveryCode(key)))) throw new Refusal('those were not the last two groups; nothing changed')
  await converting(ctx, 'rekey', old, key, () => storeKey(ctx, DB_KEY_NEXT_REF, key))
  ctx.log('memory.db has a new key.')
}

async function decrypt(ctx: Context): Promise<void> {
  requireState(ctx, 'encrypted')
  requireInteractive(ctx, 'kinfold decrypt asks you to confirm and')
  const key = readKey(ctx)
  const typed = await ctx.env.io.ask('kinfold decrypt stores memory.db in plaintext again and deletes its Keychain key. Type decrypt to go on: ')
  if (typed.trim() !== 'decrypt') throw new Refusal('nothing changed')
  await converting(ctx, 'decrypt', key, null, () => {})
  ctx.log('memory.db is plaintext.')
}

async function showRecovery(ctx: Context): Promise<void> {
  requireSecretOutput(ctx, 'kinfold key show-recovery prints a secret, so it')
  if (fileState(ctx.path) !== 'encrypted') throw new Refusal('memory.db is not encrypted; there is no recovery code')
  ctx.log(`recovery code: ${encodeRecoveryCode(readKey(ctx))}`)
}

async function recover(ctx: Context): Promise<void> {
  requireState(ctx, 'encrypted')
  const input = ctx.env.io.interactive ? await ctx.env.io.askSecret('Recovery code: ') : await ctx.env.io.readStdin()
  let key: string
  try {
    key = decodeRecoveryCode(input)
  } catch (error: unknown) {
    throw new Refusal(error instanceof RecoveryCodeError ? error.message : 'the recovery code could not be read')
  }
  try {
    openEncrypted(ctx.path, key, { readonly: true }).close()
  } catch {
    throw new Refusal('that recovery code does not open memory.db; nothing changed')
  }
  storeKey(ctx, DB_KEY_REF, key)
  if (ctx.writer.exists(DB_KEY_NEXT_REF)) ctx.writer.remove(DB_KEY_NEXT_REF)
  ctx.log(`the key is back in the Keychain as ${DB_KEY_REF}; restart the daemon if it is down`)
}

/**
 * Finishes or undoes a run that was cut short, from what is on disk. A
 * leftover backup is the original: if memory.db opens with the target key and
 * every count matches the backup, the run had finished, so the backup goes
 * and the last step is redone; otherwise the backup is put back. With no
 * backup, the run either had not started changing the file or had finished.
 * When the file opens with neither key, nothing is deleted.
 */
async function resume(ctx: Context): Promise<void> {
  const marker = maintenancePath(ctx.path)
  const backup = foundBackupPath(ctx.path)
  if (!existsSync(marker) && !existsSync(backup)) {
    ctx.log('nothing to resume: no kinfold encrypt, decrypt or rekey was cut short')
    return
  }
  const journal = readJournal(ctx.path)
  if (journal !== null && alive(journal.pid) && journal.pid !== process.pid) throw new Refusal(`a kinfold ${journal.op} is still running (pid ${journal.pid}); wait for it`)
  if (journal === null) {
    throw new Refusal(`${marker} does not say which run it belongs to; if memory.db opens (kinfold status), remove ${marker}${existsSync(backup) ? ` and keep ${backup} until you have checked it` : ''}`)
  }
  const source = keyAt(ctx, journal.source)
  // The target entry is gone once a rekey's last step ran; then nothing can be in the converted state under it.
  const target = journal.target === null ? null : ctx.keychain.get(journal.target)
  const converted = journal.target !== null && target === null ? null : checkedCounts(ctx.path, target)
  if (existsSync(backup)) {
    const original = checkedCounts(backup, source)
    if (original === null) throw new Refusal(`${backup} does not open with the old key; nothing was changed. Keep it, and run kinfold key recover if memory.db does not open`)
    if (converted !== null && sameCounts(original, converted)) {
      rmSync(backup, { force: true })
      finish(ctx, journal.op)
      ctx.log(`the ${journal.op} had finished; its backup is removed`)
    } else {
      restoreBackup(ctx.path, backup)
      undo(ctx, journal.op)
      ctx.log(`the ${journal.op} had not finished; memory.db is back as it was`)
    }
  } else if (converted !== null && fileState(ctx.path) === (journal.target === null ? 'plain' : 'encrypted')) {
    finish(ctx, journal.op)
    ctx.log(`the ${journal.op} had finished; its last step is done now`)
  } else if (checkedCounts(ctx.path, source) !== null) {
    undo(ctx, journal.op)
    ctx.log(`the ${journal.op} had not changed memory.db; it is as it was`)
  } else {
    throw new Refusal('memory.db opens with neither key; nothing was deleted. Run kinfold key recover with your recovery code')
  }
  rmSync(marker, { force: true })
  const service = serviceOf(ctx.env)
  if (service !== null && service.isConfigured() && !(await service.isRunning())) await startDaemon(ctx, { restart: true })
}

const RUN: Record<KeyCommand, (ctx: Context) => Promise<void>> = {
  encrypt,
  decrypt,
  rekey,
  'show-recovery': showRecovery,
  recover,
  resume,
}

export async function runKeyCommand(env: InstallEnv, command: KeyCommand): Promise<number> {
  try {
    await RUN[command](context(env))
    return EXIT_OK
  } catch (error: unknown) {
    env.out(error instanceof Refusal || error instanceof ConvertError ? `kinfold ${command}: ${error.message}` : `kinfold ${command}: failed (${errorMessage(error)})`)
    return EXIT_FAILED
  }
}
