// Backup and restore over the daemon's API, for the dashboard (session
// cookie) and the command line (token) alike:
//
//   GET  /backup          the backup file, as a download
//   POST /restore/upload  a backup file, streamed to <dataDir>/restore-incoming/
//   POST /restore         {"upload": "<id>", "code": "<recovery code>"}: restore it
//   GET  /restore/status  how the restore is going, and how it ended
//
// One of them runs at a time; the others answer 409 meanwhile. The upload is
// the only request whose body may pass 16 KB: it is written to disk a chunk
// at a time and dropped the moment it passes its limit, so it is never held
// in memory. The recovery code arrives only in the body of POST /restore
// (through the 16 KB reader), is turned into the key at once, and is never
// logged, stored or sent back: every error here is fixed wording.
//
// A restore runs inside the daemon. The code is checked against the snapshot
// first (src/backup/restore.ts); only then does the daemon close its store,
// let the engine swap the files, and open the restored store again. The
// server and the sessions stay up throughout, so a dashboard page watching
// /restore/status keeps its session.

import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, statfsSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { type ArchiveHeader, BACKUP_FILE_EXTENSION, BackupError } from '../backup/archive'
import { BACKUP_TMP_DIR, createBackup, privateTmpDir } from '../backup/create'
import { type RestoreStep, type Staged, applyRestore, checkRestore, discardStaged, inspectBackup, stageSnapshot } from '../backup/restore'
import type { Parsed } from '../context/types'
import { isRecord } from '../contract/event'
import type { KeyStore } from '../secrets/key-store'
import { RecoveryCodeError, decodeRecoveryCode } from '../sqlite/recovery'
import { DATA_DIR_MODE, DATA_FILE_MODE } from '../store/data-dir'
import type { RouteAnswer } from './data-routes'

export const RESTORE_INCOMING_DIR = 'restore-incoming'
/** The upload, the staged copy and the store it becomes all sit on this disk for a moment. */
const COPIES_ON_DISK = 3
const BUSY: RouteAnswer = { status: 409, body: { error: 'a backup or restore is running; try again when it finishes' } }

export interface BackupRoutes {
  download(): Promise<Response>
  upload(request: Request): Promise<RouteAnswer>
  start(readBody: () => Promise<Parsed<unknown>>): Promise<RouteAnswer>
  status(): RouteAnswer
}

export interface BackupRouteDeps {
  dataDir: string
  version: string
  now: () => number
  /** Counts, states and error names only. */
  log: (line: string) => void
  /** Writes the open store's snapshot to the path and resolves with its schema version. */
  snapshot: (dest: string) => Promise<number>
  /** Where a restored store's key goes; null when this platform has no key store. */
  keyStore: () => KeyStore | null
  /** Closes everything that holds memory.db, runs `between`, and opens the store again whether or not it threw. */
  restart: (between: () => Promise<void>) => Promise<void>
  sleep: (ms: number) => Promise<void>
  /** The most an upload may be, in bytes. */
  uploadLimit: () => number
  lockAttempts?: number
}

export interface RestoreStatus {
  state: 'idle' | 'running' | 'done' | 'failed'
  step: 'check' | RestoreStep | 'reopen' | null
  /** What the restore reported when it ended well. */
  lines: string[]
  error: string | null
}

interface Pending {
  id: string
  path: string
  header: ArchiveHeader
}

/** The upload limit for a data folder: the hard ceiling, lowered to what its disk can hold beside the copies a restore makes. */
export function uploadLimitFor(dataDir: string, ceiling: number): number {
  const stats = statfsSync(dataDir)
  return Math.min(ceiling, Math.floor((Number(stats.bavail) * Number(stats.bsize)) / COPIES_ON_DISK))
}

export function parseRestoreBody(body: unknown): Parsed<{ upload: string; code: string | null }> {
  const error = 'body must be {"upload": "<id>"} with an optional "code"'
  if (!isRecord(body) || typeof body.upload !== 'string' || Object.keys(body).some((key) => key !== 'upload' && key !== 'code')) return { ok: false, error }
  if (body.code !== undefined && typeof body.code !== 'string') return { ok: false, error }
  return { ok: true, value: { upload: body.upload, code: body.code ?? null } }
}

/** The file's bytes as a stream; the file is removed once the last byte went or the reader gave up. */
function streamThenRemove(path: string): ReadableStream<Uint8Array> {
  const reader = Bun.file(path).stream().getReader()
  const remove = (): void => {
    try {
      rmSync(path, { force: true })
    } catch {
      // Still open on Windows: the next backup's sweep of the temp folder takes it.
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          remove()
        } else {
          controller.enqueue(value)
        }
      } catch (error: unknown) {
        remove()
        controller.error(error)
      }
    },
    async cancel() {
      await reader.cancel().catch(() => {})
      remove()
    },
  })
}

function downloadName(at: number): string {
  return `kinfold-backup-${new Date(at).toISOString().slice(0, 10)}${BACKUP_FILE_EXTENSION}`
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'error')

export function backupRoutes(deps: BackupRouteDeps): BackupRoutes {
  let busy = false
  let pending: Pending | null = null
  let status: RestoreStatus = { state: 'idle', step: null, lines: [], error: null }

  const incomingDir = (): string => {
    const dir = join(deps.dataDir, RESTORE_INCOMING_DIR)
    mkdirSync(dir, { recursive: true, mode: DATA_DIR_MODE })
    return dir
  }
  const dropPending = (): void => {
    if (pending !== null) rmSync(pending.path, { force: true })
    pending = null
  }
  // Uploads from a daemon that stopped before restoring them: the id that named them is gone.
  for (const name of readdirSync(incomingDir())) rmSync(join(incomingDir(), name), { force: true })

  async function download(): Promise<Response> {
    if (busy) return Response.json(BUSY.body, { status: BUSY.status })
    busy = true
    try {
      const at = deps.now()
      const dest = join(privateTmpDir(deps.dataDir, BACKUP_TMP_DIR, at), `download-${randomBytes(8).toString('hex')}${BACKUP_FILE_EXTENSION}`)
      const manifest = await createBackup({ dataDir: deps.dataDir, dest, snapshot: deps.snapshot, version: deps.version, now: () => at })
      const bytes = statSync(dest).size
      deps.log(`backup written bytes=${bytes} schema=${manifest.schemaVersion} encrypted=${manifest.encrypted}`)
      return new Response(streamThenRemove(dest), {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${downloadName(at)}"`,
        },
      })
    } catch (error: unknown) {
      deps.log(`backup failed: ${errorName(error)}`)
      const message = error instanceof BackupError ? error.message : `the backup could not be written (${errorName(error)})`
      return Response.json({ error: message }, { status: 500 })
    } finally {
      busy = false
    }
  }

  /** Writes the body to `path` a chunk at a time; false once it passes `limit`, with the file removed. */
  async function receive(request: Request, path: string, limit: number): Promise<boolean> {
    const fd = openSync(path, 'wx', DATA_FILE_MODE)
    let total = 0
    try {
      if (request.body !== null) {
        const reader = request.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > limit) {
            await reader.cancel().catch(() => {})
            closeSync(fd)
            rmSync(path, { force: true })
            return false
          }
          let written = 0
          while (written < value.byteLength) written += writeSync(fd, value, written, value.byteLength - written)
        }
      }
    } catch (error: unknown) {
      closeSync(fd)
      rmSync(path, { force: true })
      throw error
    }
    closeSync(fd)
    return true
  }

  async function upload(request: Request): Promise<RouteAnswer> {
    if (busy) return BUSY
    const limit = deps.uploadLimit()
    const tooLarge: RouteAnswer = { status: 413, body: { error: `the backup is larger than this machine can take (${limit} bytes at most)` } }
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > limit) return tooLarge
    busy = true
    const id = randomBytes(16).toString('hex')
    const path = join(incomingDir(), `upload-${id}${BACKUP_FILE_EXTENSION}`)
    try {
      dropPending()
      if (!(await receive(request, path, limit))) return tooLarge
      const header = inspectBackup(path)
      pending = { id, path, header }
      const { manifest } = header
      deps.log(`restore upload stored bytes=${statSync(path).size} schema=${manifest.schemaVersion} encrypted=${manifest.encrypted}`)
      return {
        status: 200,
        body: { upload: id, manifest: { createdAt: manifest.createdAt, kinfoldVersion: manifest.kinfoldVersion, schemaVersion: manifest.schemaVersion, encrypted: manifest.encrypted, bytes: manifest.snapshot.bytes } },
      }
    } catch (error: unknown) {
      rmSync(path, { force: true })
      deps.log(`restore upload refused: ${error instanceof BackupError ? error.kind : errorName(error)}`)
      return error instanceof BackupError ? { status: 400, body: { error: error.message } } : { status: 500, body: { error: `the upload could not be stored (${errorName(error)})` } }
    } finally {
      busy = false
    }
  }

  /** The swap, after the code checked out: runs past the request that started it, and reports through /restore/status. */
  async function run(staged: Staged): Promise<void> {
    try {
      let lines: string[] = []
      await deps.restart(async () => {
        const outcome = await applyRestore({
          dataDir: deps.dataDir,
          staged,
          keyStore: deps.keyStore(),
          log: deps.log,
          sleep: deps.sleep,
          onStep: (step) => {
            status = { ...status, step }
          },
          ...(deps.lockAttempts !== undefined ? { lockAttempts: deps.lockAttempts } : {}),
        })
        lines = outcome.lines
        status = { ...status, step: 'reopen' }
      })
      dropPending()
      status = { state: 'done', step: null, lines, error: null }
      deps.log('restore finished')
    } catch (error: unknown) {
      deps.log(`restore failed: ${error instanceof BackupError ? error.kind : errorName(error)}`)
      status = { state: 'failed', step: null, lines: [], error: error instanceof BackupError ? error.message : `the restore failed (${errorName(error)})` }
    } finally {
      busy = false
    }
  }

  async function start(readBody: () => Promise<Parsed<unknown>>): Promise<RouteAnswer> {
    const body = await readBody()
    const parsed = body.ok ? parseRestoreBody(body.value) : body
    if (!parsed.ok) return { status: 400, body: { error: parsed.error } }
    if (busy) return BUSY
    const upload = pending
    if (upload === null || upload.id !== parsed.value.upload) return { status: 400, body: { error: 'that upload is not here any more; choose the backup file again' } }
    let key: string | null = null
    if (parsed.value.code !== null) {
      try {
        key = decodeRecoveryCode(parsed.value.code)
      } catch (error: unknown) {
        return { status: 400, body: { error: error instanceof RecoveryCodeError ? error.message : 'the recovery code could not be read' } }
      }
    }
    busy = true
    const before = status
    status = { state: 'running', step: 'check', lines: [], error: null }
    let staged: Staged
    try {
      // Everything that can refuse runs here, while the store is still open and untouched.
      staged = await stageSnapshot({ dataDir: deps.dataDir, archivePath: upload.path, header: upload.header, key })
      try {
        checkRestore({ dataDir: deps.dataDir, staged, keyStore: deps.keyStore() })
      } catch (error: unknown) {
        discardStaged(deps.dataDir)
        throw error
      }
    } catch (error: unknown) {
      busy = false
      status = before
      deps.log(`restore refused: ${error instanceof BackupError ? error.kind : errorName(error)}`)
      return error instanceof BackupError ? { status: 400, body: { error: error.message } } : { status: 500, body: { error: `the restore could not start (${errorName(error)})` } }
    }
    deps.log('restore started')
    void run(staged)
    return { status: 202, body: { started: true } }
  }

  return { download, upload, start, status: () => ({ status: 200, body: status }) }
}
