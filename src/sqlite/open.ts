// Opening memory.db through sqlite3mc. The file's first 16 bytes say
// how: the SQLite header means plaintext, anything else means encrypted, and
// an encrypted file needs the key. A store that does not exist yet is created
// encrypted when the key store has a key, and plaintext otherwise, so an
// existing plaintext store keeps opening as before until `kinfold encrypt`.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type OpenOptions, openWithLibrary } from './driver'
import type { KeyStoreDeps } from '../secrets/key-store'
import { type DbKeyStore, NO_DB_KEYS, dbKeyStoreFor } from './keys'
import { libraryFor } from './library'
import { type Database, SqliteError } from './types'

export type { OpenOptions }

const SQLITE_HEADER = 'SQLite format 3\0'

export type FileState = 'new' | 'plain' | 'encrypted'

/** 'new' for a missing or empty file; otherwise what its first 16 bytes say. Any other error throws, so a read failure never picks the plaintext path. */
export function fileState(path: string): FileState {
  let fd: number
  try {
    if (statSync(path).size === 0) return 'new'
    fd = openSync(path, 'r')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'new'
    throw error
  }
  try {
    const head = Buffer.alloc(16)
    const read = readSync(fd, head, 0, 16, 0)
    return read === 16 && head.toString('latin1') === SQLITE_HEADER ? 'plain' : 'encrypted'
  } finally {
    closeSync(fd)
  }
}

export interface PlainOpenOptions extends OpenOptions {
  /** Open this instead, such as a `file:` URI with immutable=1; the library is still found from `path`. */
  target?: string
  /**
   * How long to wait on a lock, set right after the open: before the key and before any read, since
   * the key check itself reads the file and a writer holding it would otherwise fail that read at once.
   */
  busyTimeoutMs?: number
}

export interface StoreOpenOptions extends PlainOpenOptions {
  keys?: DbKeyStore
  env?: Readonly<Record<string, string | undefined>>
  /** Used only when `keys` is absent; default processKeyStoreDeps. Tests pass a fake `security` here. */
  keyStoreDeps?: KeyStoreDeps
}

/** While this file sits in the data dir, `kinfold encrypt|decrypt|rekey` is changing memory.db and nothing else may open it. */
export const MAINTENANCE_FILE = 'maintenance'

export function maintenancePath(dbPath: string): string {
  return join(dirname(dbPath), MAINTENANCE_FILE)
}

function openWaiting(path: string, options: PlainOpenOptions, env: Readonly<Record<string, string | undefined>>): Database {
  const db = openWithLibrary(libraryFor(path, env), options.target ?? path, options)
  if (options.busyTimeoutMs === undefined) return db
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs))}`)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

export function openPlain(path: string, options: PlainOpenOptions = {}, env: Readonly<Record<string, string | undefined>> = process.env): Database {
  return openWaiting(path, options, env)
}

/** Opens with the key and proves it with a read; a wrong key throws kind bad_key. The key is never kept or put in an error. */
export function openEncrypted(path: string, key: string, options: PlainOpenOptions = {}, env: Readonly<Record<string, string | undefined>> = process.env): Database {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new SqliteError('the database key is not 64 hex characters', 'SQLITE_AUTH', 23, 'bad_key')
  const db = openWaiting(path, options, env)
  try {
    db.exec(`PRAGMA key = 'raw:${key}'`)
    // A library that ignored the key would answer this with no cipher; refuse rather than store plaintext.
    // sqlite3mc answers one row whose one column is the cipher name (`chacha20`).
    const cipher = db.query<Record<string, unknown>, []>('PRAGMA cipher').values()[0]?.[0]
    if (typeof cipher !== 'string' || cipher === '') {
      throw new SqliteError('the SQLite library did not take the database key', 'SQLITE_CANTOPEN', 14, 'library')
    }
    db.query('SELECT count(*) FROM sqlite_master').get()
    return db
  } catch (error: unknown) {
    db.close()
    if (error instanceof SqliteError && error.code === 'SQLITE_NOTADB') throw new SqliteError('the database key does not open this file', 'SQLITE_NOTADB', 26, 'bad_key')
    throw error
  }
}

/**
 * True when the store is plaintext while the key store holds a key: the file
 * was replaced by a plaintext copy, or a conversion failed. Metadata only.
 */
export function plaintextBesideKey(path: string, keys: DbKeyStore = dbKeyStoreFor(dirname(path))): boolean {
  return fileState(path) === 'plain' && keys.exists()
}

/** The store as its file says: plaintext, encrypted with the key, or (new) encrypted when a key exists. */
export function openStoreFile(path: string, options: StoreOpenOptions = {}): Database {
  if (existsSync(maintenancePath(path))) {
    throw new SqliteError('memory.db is being converted (kinfold encrypt, decrypt or rekey); try again when it finishes', 'SQLITE_BUSY', 5, 'maintenance')
  }
  const env = options.env ?? process.env
  const state = fileState(path)
  if (state === 'plain') return openPlain(path, options, env)
  const keys = options.keys ?? dbKeyStoreFor(dirname(path), env, options.keyStoreDeps)
  const key = keys.read()
  if (key !== null) return openEncrypted(path, key, options, env)
  if (state === 'encrypted') throw new SqliteError(`memory.db is encrypted and the ${keys.name} has no database key; run kinfold key recover`, 'SQLITE_AUTH', 23, 'no_key')
  // A platform with a key store never creates a plaintext store by accident: kinfold install puts the key first.
  if (keys.name !== NO_DB_KEYS.name) throw new SqliteError(`memory.db does not exist yet and the ${keys.name} has no database key; run kinfold install`, 'SQLITE_AUTH', 23, 'no_key')
  return openPlain(path, options, env)
}
