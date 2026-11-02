// Database and Statement over sqlite3mc. The behaviour follows
// bun:sqlite with strict binding, and src/sqlite/contract.test.ts holds both to
// it. Text and blobs bind with SQLITE_TRANSIENT, so SQLite copies them and no
// JS buffer outlives a call. A statement the cache drops may still be held by
// a caller, so it is finalized only once unreachable; close() uses
// sqlite3_close_v2, which waits for any statement still alive.

import { CString, type Pointer, toArrayBuffer } from 'bun:ffi'
import {
  COLUMN_BLOB, COLUMN_FLOAT, COLUMN_INTEGER, COLUMN_TEXT, OPEN_CREATE, OPEN_FULLMUTEX, OPEN_READONLY, OPEN_READWRITE, OPEN_URI,
  SQLITE_DONE, SQLITE_OK, SQLITE_ROW, type Sqlite3, sqlite3,
} from './ffi'
import { type BindArgs, type BindValue, type Bindings, type Database, type RunResult, SqliteError, type Statement } from './types'

/** SQLITE_TRANSIENT, (sqlite3_destructor_type)-1. */
const TRANSIENT = -1 as unknown as Pointer
export const QUERY_CACHE_LIMIT = 256
const EMPTY = new Uint8Array(1)
const utf8 = new TextEncoder()

const PRIMARY_NAMES = [
  'OK', 'ERROR', 'INTERNAL', 'PERM', 'ABORT', 'BUSY', 'LOCKED', 'NOMEM', 'READONLY', 'INTERRUPT', 'IOERR', 'CORRUPT', 'NOTFOUND', 'FULL',
  'CANTOPEN', 'PROTOCOL', 'EMPTY', 'SCHEMA', 'TOOBIG', 'CONSTRAINT', 'MISMATCH', 'MISUSE', 'NOLFS', 'AUTH', 'FORMAT', 'RANGE', 'NOTADB',
  'NOTICE', 'WARNING',
]
const EXTENDED_NAMES: Readonly<Record<number, string>> = {
  261: 'BUSY_RECOVERY', 517: 'BUSY_SNAPSHOT', 262: 'LOCKED_SHAREDCACHE', 1032: 'READONLY_DBMOVED',
  275: 'CONSTRAINT_CHECK', 531: 'CONSTRAINT_COMMITHOOK', 787: 'CONSTRAINT_FOREIGNKEY', 1043: 'CONSTRAINT_FUNCTION', 1299: 'CONSTRAINT_NOTNULL',
  1555: 'CONSTRAINT_PRIMARYKEY', 1811: 'CONSTRAINT_TRIGGER', 2067: 'CONSTRAINT_UNIQUE', 2323: 'CONSTRAINT_VTAB', 2579: 'CONSTRAINT_ROWID',
}

/** `SQLITE_CONSTRAINT_PRIMARYKEY` for 1555, as bun:sqlite names it; unknown extended codes fall back to their primary name. */
export function resultName(errno: number): string {
  return `SQLITE_${EXTENDED_NAMES[errno] ?? PRIMARY_NAMES[errno & 0xff] ?? String(errno)}`
}

function cstring(text: string): Uint8Array {
  return utf8.encode(`${text}\0`)
}

function isNamed(args: readonly unknown[]): args is [Record<string, BindValue>] {
  const [first] = args
  return args.length === 1 && typeof first === 'object' && first !== null && !ArrayBuffer.isView(first)
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

class Connection {
  readonly cache = new Map<string, FfiStatement>()
  private depth = 0
  closed = false

  constructor(readonly f: Sqlite3, readonly handle: Pointer) {}

  fail(rc: number): SqliteError {
    const errno = this.f.sqlite3_extended_errcode(this.handle) || rc
    return new SqliteError(String(this.f.sqlite3_errmsg(this.handle)), resultName(errno), errno)
  }

  check(): void {
    if (this.closed) throw new SqliteError('database is closed', 'SQLITE_MISUSE', 21, 'closed')
  }

  prepare(sql: string): Pointer {
    this.check()
    const out = new BigUint64Array(1)
    const rc = this.f.sqlite3_prepare_v2(this.handle, cstring(sql), -1, out, null)
    if (rc !== SQLITE_OK) throw this.fail(rc)
    const handle = Number(out[0])
    if (handle === 0) throw new SqliteError('empty statement', 'SQLITE_MISUSE', 21)
    return handle as unknown as Pointer
  }

  /** `wrote` false for a statement that changes nothing: bun:sqlite reports 0 changes then, not the last write's count. */
  runResult(wrote = true): RunResult {
    return { changes: wrote ? Number(this.f.sqlite3_changes64(this.handle)) : 0, lastInsertRowid: Number(this.f.sqlite3_last_insert_rowid(this.handle)) }
  }

  exec(sql: string): void {
    this.check()
    const rc = this.f.sqlite3_exec(this.handle, cstring(sql), null, null, null)
    if (rc !== SQLITE_OK) throw this.fail(rc)
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const level = this.depth
      const savepoint = `sam_tx_${level}`
      this.exec(level === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
      this.depth = level + 1
      try {
        const result = fn(...args)
        this.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`)
        return result
      } catch (error: unknown) {
        if (level === 0) {
          if (this.f.sqlite3_get_autocommit(this.handle) === 0) this.exec('ROLLBACK')
        } else {
          this.exec(`ROLLBACK TO ${savepoint}`)
          this.exec(`RELEASE ${savepoint}`)
        }
        throw error
      } finally {
        this.depth = level
      }
    }
  }
}

/** Finalizes statements nobody can reach any more: ones the cache dropped, or prepare() results never finalized. */
const unreachable = new FinalizationRegistry<{ f: Sqlite3; handle: Pointer }>(({ f, handle }) => {
  f.sqlite3_finalize(handle)
})

class FfiStatement<Row = unknown, Params extends Bindings = Bindings> implements Statement<Row, Params> {
  private readonly names: (string | null)[]
  private readonly columns: string[]
  private readonly readonly: boolean
  finalized = false
  private readonly token = {}

  constructor(private readonly conn: Connection, private readonly handle: Pointer) {
    const f = conn.f
    const params = f.sqlite3_bind_parameter_count(handle)
    this.names = Array.from({ length: params }, (_, i) => {
      const name = f.sqlite3_bind_parameter_name(handle, i + 1)
      return name === null ? null : String(name)
    })
    this.columns = Array.from({ length: f.sqlite3_column_count(handle) }, (_, i) => String(f.sqlite3_column_name(handle, i)))
    this.readonly = f.sqlite3_stmt_readonly(handle) !== 0
    unreachable.register(this, { f, handle }, this.token)
  }

  private start(given: readonly unknown[]): void {
    if (this.finalized) throw new SqliteError('statement is finalized', 'SQLITE_MISUSE', 21, 'closed')
    this.conn.check()
    const f = this.conn.f
    f.sqlite3_reset(this.handle)
    f.sqlite3_clear_bindings(this.handle)
    // One array argument binds positionally, as in bun:sqlite.
    const args = given.length === 1 && Array.isArray(given[0]) ? given[0] as unknown[] : given
    if (isNamed(args)) {
      const values = args[0]
      this.names.forEach((name, i) => {
        const key = name === null ? null : name.slice(1)
        if (key === null || !(key in values)) throw new Error(`Missing parameter "${key ?? i + 1}"`)
        this.bind(i + 1, values[key])
      })
      return
    }
    if (args.length !== this.names.length) throw new Error(`SQLite query expected ${this.names.length} values, received ${args.length}`)
    args.forEach((value, i) => this.bind(i + 1, value as BindValue))
  }

  private bind(index: number, value: BindValue): void {
    const f = this.conn.f
    let rc: number
    if (value === null || value === undefined || Number.isNaN(value)) rc = f.sqlite3_bind_null(this.handle, index)
    else if (typeof value === 'boolean') rc = f.sqlite3_bind_int64(this.handle, index, value ? 1n : 0n)
    else if (typeof value === 'bigint') rc = f.sqlite3_bind_int64(this.handle, index, value)
    else if (typeof value === 'number') {
      rc = Number.isSafeInteger(value) ? f.sqlite3_bind_int64(this.handle, index, BigInt(value)) : f.sqlite3_bind_double(this.handle, index, value)
    } else if (typeof value === 'string') {
      const bytes = utf8.encode(value)
      rc = f.sqlite3_bind_text(this.handle, index, bytes.length === 0 ? EMPTY : bytes, bytes.length, TRANSIENT)
    } else {
      const bytes = bytesOf(value)
      rc = f.sqlite3_bind_blob(this.handle, index, bytes.length === 0 ? EMPTY : bytes, bytes.length, TRANSIENT)
    }
    if (rc !== SQLITE_OK) throw this.conn.fail(rc)
  }

  private column(i: number): unknown {
    const f = this.conn.f
    switch (f.sqlite3_column_type(this.handle, i)) {
      case COLUMN_INTEGER: return Number(f.sqlite3_column_int64(this.handle, i))
      case COLUMN_FLOAT: return f.sqlite3_column_double(this.handle, i)
      case COLUMN_TEXT: {
        const p = f.sqlite3_column_text(this.handle, i)
        const length = f.sqlite3_column_bytes(this.handle, i)
        return p === null || length === 0 ? '' : new CString(p, 0, length).toString()
      }
      case COLUMN_BLOB: {
        const p = f.sqlite3_column_blob(this.handle, i)
        const length = f.sqlite3_column_bytes(this.handle, i)
        return p === null || length === 0 ? new Uint8Array(0) : new Uint8Array(toArrayBuffer(p, 0, length).slice(0))
      }
      default: return null
    }
  }

  /** Steps to the end, handing each row to `row`; always resets, so no read holds a WAL snapshot between calls. */
  private each(args: readonly unknown[], row: (() => boolean) | null): void {
    this.start(args)
    const f = this.conn.f
    try {
      for (;;) {
        const rc = f.sqlite3_step(this.handle)
        if (rc === SQLITE_DONE) return
        if (rc !== SQLITE_ROW) throw this.conn.fail(rc)
        if (row !== null && !row()) return
      }
    } finally {
      f.sqlite3_reset(this.handle)
    }
  }

  private object(): Row {
    const out: Record<string, unknown> = {}
    this.columns.forEach((name, i) => { out[name] = this.column(i) })
    return out as Row
  }

  get(...params: BindArgs<Params>): Row | null {
    let found: Row | null = null
    this.each(params, () => { found = this.object(); return false })
    return found
  }

  all(...params: BindArgs<Params>): Row[] {
    const rows: Row[] = []
    this.each(params, () => { rows.push(this.object()); return true })
    return rows
  }

  values(...params: BindArgs<Params>): unknown[][] {
    const rows: unknown[][] = []
    this.each(params, () => { rows.push(this.columns.map((_, i) => this.column(i))); return true })
    return rows
  }

  run(...params: BindArgs<Params>): RunResult {
    this.each(params, null)
    return this.conn.runResult(!this.readonly)
  }

  finalize(): void {
    if (this.finalized) return
    this.finalized = true
    unreachable.unregister(this.token)
    this.conn.f.sqlite3_finalize(this.handle)
  }
}

class FfiDatabase implements Database {
  constructor(private readonly conn: Connection) {}

  query<Row = unknown, Params extends Bindings = Bindings>(sql: string): Statement<Row, Params> {
    const cache = this.conn.cache
    const hit = cache.get(sql)
    if (hit !== undefined && hit.finalized) cache.delete(sql)
    else if (hit !== undefined) {
      cache.delete(sql)
      cache.set(sql, hit)
      return hit as unknown as Statement<Row, Params>
    }
    const statement = new FfiStatement(this.conn, this.conn.prepare(sql))
    cache.set(sql, statement)
    if (cache.size > QUERY_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    return statement as unknown as Statement<Row, Params>
  }

  prepare<Row = unknown, Params extends Bindings = Bindings>(sql: string): Statement<Row, Params> {
    return new FfiStatement<Row, Params>(this.conn, this.conn.prepare(sql))
  }

  run(sql: string, ...params: BindArgs): RunResult {
    if (params.length === 0) {
      this.conn.exec(sql)
      return this.conn.runResult()
    }
    const statement = this.prepare(sql)
    try {
      return statement.run(...params)
    } finally {
      statement.finalize()
    }
  }

  exec(sql: string): void {
    this.conn.exec(sql)
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return this.conn.transaction(fn)
  }

  loadExtension(path: string): void {
    this.conn.check()
    const f = this.conn.f
    const message = new BigUint64Array(1)
    f.sqlite3_enable_load_extension(this.conn.handle, 1)
    try {
      const rc = f.sqlite3_load_extension(this.conn.handle, cstring(path), null, message)
      if (rc !== SQLITE_OK) {
        const p = Number(message[0])
        const text = p === 0 ? 'extension failed to load' : new CString(p as unknown as Pointer).toString()
        if (p !== 0) f.sqlite3_free(p as unknown as Pointer)
        throw new SqliteError(text, resultName(rc), rc)
      }
    } finally {
      f.sqlite3_enable_load_extension(this.conn.handle, 0)
    }
  }

  close(): void {
    if (this.conn.closed) return
    for (const statement of this.conn.cache.values()) statement.finalize()
    this.conn.cache.clear()
    this.conn.closed = true
    this.conn.f.sqlite3_close_v2(this.conn.handle)
  }
}

export interface OpenOptions {
  readonly?: boolean
  /** Create the file when missing (read-write only). Default true for read-write. */
  create?: boolean
}

/** Opens `path` with the library at `libraryPath`. No key: open.ts adds it before anything reads the file. */
export function openWithLibrary(libraryPath: string, path: string, options: OpenOptions = {}): Database {
  const f = sqlite3(libraryPath)
  const flags = (options.readonly === true ? OPEN_READONLY : OPEN_READWRITE | (options.create === false ? 0 : OPEN_CREATE)) | OPEN_URI | OPEN_FULLMUTEX
  const out = new BigUint64Array(1)
  const rc = f.sqlite3_open_v2(cstring(path), out, flags, null)
  const handle = Number(out[0]) as unknown as Pointer
  if (rc !== SQLITE_OK) {
    const message = handle === (0 as unknown as Pointer) ? String(f.sqlite3_errstr(rc)) : String(f.sqlite3_errmsg(handle))
    if (handle !== (0 as unknown as Pointer)) f.sqlite3_close_v2(handle)
    throw new SqliteError(message, resultName(rc), rc)
  }
  // No busy timeout, as in bun:sqlite: openStore sets its own, and the hook fallback must not wait.
  return new FfiDatabase(new Connection(f, handle))
}
