// Serves the stored pack when the daemon is unreachable (plan "Reads survive a
// daemon restart"). Decision D3 keeps every write in the daemon, so this path
// opens the database read-only, runs no migrations and records no injection;
// it says so in its log line. A plain read-only open of a WAL database creates
// -wal and -shm when they are missing, so it is tried only when both exist (a
// daemon is or was running); otherwise the file opens with immutable=1, which
// may miss the newest pack (the WAL is ignored) but never writes. On the prompt
// channel it computes the delta from the same read-only connection; that
// delta is not recorded either, so the next prompt may repeat it.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DbKeyStore } from '../sqlite/keys'
import { openStoreFile } from '../sqlite/open'
import { type Database, SqliteError } from '../sqlite/types'
import { DB_FILE } from '../store/data-dir'
import { readPack } from '../store/context-store'
import { GIT_TIMEOUT_MS, type GitRunner, GitTimeoutError, gitRunnerWithTimeout, resolveProjectKey } from '../store/project-key'
import { computeDelta } from './delta'
import { type ContextRequest, type ContextResult, hostProfileFor } from './types'

/** host and cwd pick the pack; a prompt channel with its host session asks for the delta instead (P1-H). */
export type StoredContextRequest = Pick<ContextRequest, 'host' | 'cwd'> & Partial<Pick<ContextRequest, 'hostSessionId' | 'channel'>>

export interface FallbackOptions {
  /** What is left of the caller's budget; git gets no more than this. */
  budgetMs: number
  log?: (line: string) => void
  git?: GitRunner
  now?: () => number
}

function immutableUri(path: string): string {
  return `file:${path.split('/').map(encodeURIComponent).join('/')}?mode=ro&immutable=1`
}

/**
 * Why the store could not be opened, safe to log: our own library message,
 * which says to run sam install, or the SQLite code alone, since SQLite's
 * text can quote SQL.
 */
export function openFailure(error: unknown): string {
  if (error instanceof SqliteError) return error.kind === 'library' || error.kind === 'maintenance' ? `${error.code}: ${error.message}` : error.code
  return error instanceof Error ? error.name : 'error'
}

/** A plain read-only open when the WAL side files exist, then immutable; null when neither works, after telling `onError` why. */
export function openReadOnly(path: string, onError: (error: unknown) => void = () => {}, keys?: DbKeyStore): Database | null {
  const sideFiles = existsSync(`${path}-wal`) && existsSync(`${path}-shm`)
  for (const target of sideFiles ? [path, immutableUri(path)] : [immutableUri(path)]) {
    let db: Database | null = null
    try {
      db = openStoreFile(path, { readonly: true, target, keys })
      db.query('SELECT 1 FROM context_packs LIMIT 1').get()
      return db
    } catch (error: unknown) {
      db?.close()
      if (!(error instanceof Error)) throw error
      onError(error)
    }
  }
  return null
}

/** The stored pack for the request's project and host profile, or null. Never writes. */
export function readStoredContext(dataDir: string, request: StoredContextRequest, options: FallbackOptions): ContextResult | null {
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const startedAt = now()
  const path = join(dataDir, DB_FILE)
  if (!existsSync(path)) return null
  let failure = 'unknown'
  const db = openReadOnly(path, (error) => { failure = openFailure(error) })
  if (db === null) {
    log(`context fallback: database could not be opened read-only (${failure})`)
    return null
  }
  try {
    const git = options.git ?? gitRunnerWithTimeout(Math.max(1, Math.min(GIT_TIMEOUT_MS, Math.floor(options.budgetMs))))
    let project: ReturnType<typeof resolveProjectKey>
    try {
      project = resolveProjectKey(request.cwd, git)
    } catch (error: unknown) {
      if (!(error instanceof GitTimeoutError)) throw error
      // Unknown project: a path-key guess would read the wrong pack, so serve none.
      log(`context fallback: pack=none (git timed out) ms=${now() - startedAt}`)
      return null
    }
    if (request.channel === 'prompt' && request.hostSessionId !== undefined) {
      const delta = computeDelta(db, { host: request.host, hostSessionId: request.hostSessionId }, project.key, now())
      log(`context fallback: delta ids=${delta.observationIds.length} tokens=${delta.tokens} ms=${now() - startedAt}; injection not recorded (read-only path)`)
      return delta.text === '' ? null : delta
    }
    const pack = readPack(db, project.key, hostProfileFor(request.host))
    const result = pack === null ? null : { text: pack.body, observationIds: pack.observationIds, tokens: pack.tokenCount }
    log(`context fallback: pack=${pack === null ? 'none' : 'stored'} ids=${result?.observationIds.length ?? 0} tokens=${result?.tokens ?? 0} ms=${now() - startedAt}; injection not recorded (read-only path)`)
    return result
  } finally {
    db.close()
  }
}
