// `kinfold backup <file>`, `kinfold restore <file>` and `kinfold restore --undo`.
//
// With the daemon running, both go through its authenticated routes: the
// daemon holds the store open and unlocked, so it writes the snapshot, and a
// restore runs inside it without stopping the service. With the daemon down,
// this process opens the store itself and runs the same steps
// (src/backup/create.ts, src/backup/restore.ts).
//
// The recovery code is read without echo (or from stdin), checked by its
// checksum here, and then lives only in this process and, on the daemon path,
// in the body of the one restore request. It is never printed, logged or put
// in a URL.

import { chmodSync, closeSync, existsSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { type BackupManifest, BackupError, readArchive } from '../backup/archive'
import { createBackup } from '../backup/create'
import { applyRestore, inspectBackup, stageSnapshot } from '../backup/restore'
import { snapshotStoreFile } from '../backup/snapshot'
import { applyUndo } from '../backup/undo'
import { isRecord } from '../contract/event'
import { readDaemonEndpoint } from '../daemon/daemon-info'
import { DB_KEY_REF } from '../secrets/credentials'
import { dbKeyStoreOf } from '../sqlite/keys'
import { fileState, maintenancePath } from '../sqlite/open'
import { RecoveryCodeError, decodeRecoveryCode, encodeRecoveryCode } from '../sqlite/recovery'
import { DATA_FILE_MODE, DB_FILE } from '../store/data-dir'
import { VERSION } from '../version'
import type { BackupArgs } from './args'
import { checkHealth, readDaemonInfo } from './daemon-client'
import { type InstallEnv, errorMessage } from './env'
import { EXIT_FAILED, EXIT_OK } from './install'
import { keyStoreOf } from './key-store-choice'
import type { CommandBusy } from './prompt/frame'
import { PromptCancelled } from './prompt/prompts'

class Refusal extends Error {}

export const STATUS_POLL_MS = 500
/** A restore waits up to 36 s for agent sessions and then copies; past this the command stops watching, the daemon does not stop working. */
const STATUS_WAIT_MS = 15 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000

const CUT_SHORT = 'a kinfold encrypt, decrypt, rekey or restore is running or was cut short; if none is running, run kinfold key resume'

function describe(manifest: BackupManifest): string {
  return `made ${new Date(manifest.createdAt).toISOString()} by Kinfold ${manifest.kinfoldVersion}, schema ${manifest.schemaVersion}, ${manifest.snapshot.bytes} bytes, ${manifest.encrypted ? 'encrypted' : 'not encrypted'}`
}

function pathOf(env: InstallEnv, file: string): string {
  return isAbsolute(file) ? file : resolve(env.cwd, file)
}

interface Endpoint {
  base: string
  token: string
}

/** The running daemon's address and token; null when nothing answers /health, so the command works on the store itself. */
async function runningDaemon(env: InstallEnv): Promise<Endpoint | null> {
  const health = await checkHealth(env, readDaemonInfo(env.dataDir).port)
  if (!health.up) return null
  const endpoint = readDaemonEndpoint(env.dataDir)
  if (endpoint === null) throw new Refusal('a daemon answers /health but daemon.json or daemon.token is missing; restart it, then run this again')
  return { base: `http://127.0.0.1:${endpoint.port}`, token: endpoint.token }
}

/** The daemon's own error text, which is fixed wording; never the body that was sent. */
async function refusalOf(response: Response, what: string): Promise<Refusal> {
  if (response.status === 404) return new Refusal(`the running daemon is an older build without ${what}; restart it (kinfold install), then run this again`)
  const body: unknown = await response.json().catch(() => null)
  return new Refusal(isRecord(body) && typeof body.error === 'string' ? body.error : `${what} answered ${response.status}`)
}

function backedUp(env: InstallEnv, dest: string, manifest: BackupManifest, busy: CommandBusy | undefined): void {
  env.out(`backup written: ${dest}`)
  // On a terminal that line is the spinner's result; the rest follows it.
  busy?.done()
  env.out(`  ${describe(manifest)}`)
  if (manifest.encrypted) env.out("restoring it needs this store's recovery code; kinfold key show-recovery prints it")
  else env.out('warning: this store is not encrypted, so the backup file is readable by anyone who has it')
}

async function backupThroughDaemon(env: InstallEnv, daemon: Endpoint, dest: string): Promise<BackupManifest> {
  const response = await env.fetch(`${daemon.base}/backup`, { headers: { authorization: `Bearer ${daemon.token}` } })
  if (response.status !== 200 || response.body === null) throw await refusalOf(response, 'GET /backup')
  const partial = `${dest}.partial`
  rmSync(partial, { force: true })
  try {
    // Owner-only from the first byte: a backup of an unencrypted store is readable memory.
    const fd = openSync(partial, 'wx', DATA_FILE_MODE)
    try {
      for await (const chunk of response.body) {
        let written = 0
        while (written < chunk.byteLength) written += writeSync(fd, chunk, written, chunk.byteLength - written)
      }
    } finally {
      closeSync(fd)
    }
    // The whole archive arrived only if it reads as one: a connection cut short does not.
    const { manifest } = readArchive(partial)
    if (existsSync(dest)) throw new Refusal(`${dest} exists already; choose another name or remove it`)
    renameSync(partial, dest)
    return manifest
  } finally {
    rmSync(partial, { force: true })
  }
}

async function backupFromStore(env: InstallEnv, dest: string): Promise<BackupManifest> {
  const dbPath = join(env.dataDir, DB_FILE)
  const state = fileState(dbPath)
  if (state === 'new') throw new Refusal(`there is no memory to back up yet: ${dbPath} does not exist`)
  let key: string | null = null
  if (state === 'encrypted') {
    const store = keyStoreOf(env)
    key = dbKeyStoreOf(store).read()
    if (key === null) throw new Refusal(`memory.db is encrypted and ${store?.place ?? 'the key store'} has no ${DB_KEY_REF}; restore it with kinfold key recover`)
  }
  const storeKey = key
  return createBackup({
    dataDir: env.dataDir,
    dest,
    snapshot: (path) => snapshotStoreFile({ dbPath, key: storeKey, dest: path }),
    version: VERSION,
    now: env.now,
  })
}

async function backup(env: InstallEnv, file: string): Promise<void> {
  const dest = pathOf(env, file)
  if (existsSync(dest)) throw new Refusal(`${dest} exists already; choose another name or remove it`)
  const busy = env.ui?.busy('writing the backup')
  try {
    const daemon = await runningDaemon(env)
    const manifest = daemon === null ? await backupFromStore(env, dest) : await backupThroughDaemon(env, daemon, dest)
    chmodSync(dest, DATA_FILE_MODE)
    backedUp(env, dest, manifest, busy)
  } catch (error: unknown) {
    busy?.fail()
    throw error
  }
}

/** The key the typed code stands for. The checksum catches a mistyped group here, before anything is opened. */
async function readKey(env: InstallEnv): Promise<string> {
  const input = env.io.interactive ? await env.io.askSecret('Recovery code: ') : await env.io.readStdin()
  try {
    return decodeRecoveryCode(input)
  } catch (error: unknown) {
    throw new Refusal(error instanceof RecoveryCodeError ? error.message : 'the recovery code could not be read')
  }
}

interface RestoreStatus {
  state: string
  lines: string[]
  error: string | null
}

function statusOf(body: unknown): RestoreStatus | null {
  if (!isRecord(body) || typeof body.state !== 'string') return null
  const lines = Array.isArray(body.lines) ? body.lines.filter((line): line is string => typeof line === 'string') : []
  return { state: body.state, lines, error: typeof body.error === 'string' ? body.error : null }
}

/** What a restore did. On a terminal the first line, which says the backup was restored, is the spinner's result; the notes follow it. */
function sayOutcome(env: InstallEnv, lines: readonly string[], busy: CommandBusy | undefined): void {
  for (const [index, line] of lines.entries()) {
    env.out(line)
    if (index === 0) busy?.done()
  }
}

async function restoreThroughDaemon(env: InstallEnv, daemon: Endpoint, file: string, key: string | null, busy: CommandBusy | undefined): Promise<void> {
  const authorization = `Bearer ${daemon.token}`
  const uploaded = await env.fetch(`${daemon.base}/restore/upload`, { method: 'POST', headers: { authorization, 'content-type': 'application/octet-stream' }, body: Bun.file(file) })
  if (uploaded.status !== 200) throw await refusalOf(uploaded, 'POST /restore/upload')
  const answer: unknown = await uploaded.json()
  if (!isRecord(answer) || typeof answer.upload !== 'string') throw new Refusal('the daemon did not name the upload')
  // The code travels in this one request body, in its canonical spelling, and nowhere else.
  const body = JSON.stringify(key === null ? { upload: answer.upload } : { upload: answer.upload, code: encodeRecoveryCode(key) })
  const started = await env.fetch(`${daemon.base}/restore`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (started.status !== 202) throw await refusalOf(started, 'POST /restore')
  await followDaemon(env, daemon, busy, 'the restore')
}

/** Watches GET /restore/status until the run in the daemon ends, and says how. */
async function followDaemon(env: InstallEnv, daemon: Endpoint, busy: CommandBusy | undefined, what: string): Promise<void> {
  const authorization = `Bearer ${daemon.token}`
  const deadline = env.now() + STATUS_WAIT_MS
  for (;;) {
    const response = await env.fetch(`${daemon.base}/restore/status`, { headers: { authorization }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    const status = response.status === 200 ? statusOf(await response.json().catch(() => null)) : null
    if (status?.state === 'done') {
      sayOutcome(env, status.lines, busy)
      return
    }
    if (status?.state === 'failed') throw new Refusal(status.error ?? `${what} failed`)
    if (env.now() >= deadline) throw new Refusal(`${what} is still running in the daemon; kinfold status shows when it is done`)
    await env.sleep(STATUS_POLL_MS)
  }
}

async function restoreIntoStore(env: InstallEnv, file: string, key: string | null, busy: CommandBusy | undefined): Promise<void> {
  const staged = await stageSnapshot({ dataDir: env.dataDir, archivePath: file, header: inspectBackup(file), key })
  const outcome = await applyRestore({ dataDir: env.dataDir, staged, keyStore: keyStoreOf(env), log: env.out, sleep: env.sleep })
  sayOutcome(env, outcome.lines, busy)
  env.out('the daemon is not running; start it when you are ready')
}

async function restore(env: InstallEnv, file: string): Promise<void> {
  const source = pathOf(env, file)
  if (!existsSync(source)) throw new Refusal(`${source} does not exist`)
  // Every refusal that needs no code comes before the code is asked for.
  const { manifest } = inspectBackup(source)
  env.out(`backup: ${describe(manifest)}`)
  if (existsSync(maintenancePath(join(env.dataDir, DB_FILE)))) throw new Refusal(CUT_SHORT)
  const daemon = await runningDaemon(env)
  if (manifest.encrypted && daemon === null && keyStoreOf(env) === null) throw new Refusal('this backup is encrypted, and there is no key store here to keep its key in')
  const key = manifest.encrypted ? await readKey(env) : null
  const busy = env.ui?.busy('restoring the memory')
  try {
    if (daemon === null) await restoreIntoStore(env, source, key, busy)
    else await restoreThroughDaemon(env, daemon, source, key, busy)
    busy?.done()
  } catch (error: unknown) {
    busy?.fail()
    throw error
  }
}

/** `restore --undo`: the daemon's route when it runs, the same steps here when it does not. No recovery code: both keys are in the key store. */
async function undo(env: InstallEnv): Promise<void> {
  const daemon = await runningDaemon(env)
  const busy = env.ui?.busy('switching back')
  try {
    if (daemon === null) {
      const outcome = await applyUndo({ dataDir: env.dataDir, keyStore: keyStoreOf(env), log: env.out, sleep: env.sleep, now: env.now })
      sayOutcome(env, outcome.lines, busy)
      env.out('the daemon is not running; start it when you are ready')
    } else {
      const started = await env.fetch(`${daemon.base}/restore/undo`, { method: 'POST', headers: { authorization: `Bearer ${daemon.token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (started.status !== 202) throw await refusalOf(started, 'POST /restore/undo')
      await followDaemon(env, daemon, busy, 'the switch back')
    }
    busy?.done()
  } catch (error: unknown) {
    busy?.fail()
    throw error
  }
}

export async function runBackupCommand(env: InstallEnv, args: BackupArgs): Promise<number> {
  try {
    await ('undo' in args ? undo(env) : args.command === 'backup' ? backup(env, args.file) : restore(env, args.file))
    return EXIT_OK
  } catch (error: unknown) {
    // Ctrl-C at the recovery code is the person stopping, not a failure: the frame ends the run with 130.
    if (error instanceof PromptCancelled) throw error
    const reason = error instanceof Refusal || error instanceof BackupError ? error.message : `failed (${errorMessage(error)})`
    ;(env.ui?.error ?? env.out)(`kinfold ${args.command}: ${reason}`)
    return EXIT_FAILED
  }
}
