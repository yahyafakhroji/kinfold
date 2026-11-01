// The sqlite3mc C API through bun:ffi (P2-E). This is the only file that
// imports bun:ffi; driver.ts builds the Database on top. The library is opened
// once per process: a second path in the same process is refused, since two
// SQLite copies in one process do not share lock state. sqlite3mc_version is
// in the symbol table on purpose: a stock SQLite lacks it, so it cannot load,
// and a store meant to be encrypted can never land in plaintext through it.

import { type Library, dlopen } from 'bun:ffi'
import { SqliteError } from './types'

const SYMBOLS = {
  sqlite3_libversion: { args: [], returns: 'cstring' },
  sqlite3mc_version: { args: [], returns: 'cstring' },
  sqlite3_open_v2: { args: ['ptr', 'ptr', 'i32', 'ptr'], returns: 'i32' },
  sqlite3_close_v2: { args: ['ptr'], returns: 'i32' },
  sqlite3_errmsg: { args: ['ptr'], returns: 'cstring' },
  sqlite3_errstr: { args: ['i32'], returns: 'cstring' },
  sqlite3_extended_errcode: { args: ['ptr'], returns: 'i32' },
  sqlite3_busy_timeout: { args: ['ptr', 'i32'], returns: 'i32' },
  sqlite3_exec: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  sqlite3_changes64: { args: ['ptr'], returns: 'i64' },
  sqlite3_last_insert_rowid: { args: ['ptr'], returns: 'i64' },
  sqlite3_get_autocommit: { args: ['ptr'], returns: 'i32' },
  sqlite3_enable_load_extension: { args: ['ptr', 'i32'], returns: 'i32' },
  sqlite3_load_extension: { args: ['ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  sqlite3_free: { args: ['ptr'], returns: 'void' },
  sqlite3_prepare_v2: { args: ['ptr', 'ptr', 'i32', 'ptr', 'ptr'], returns: 'i32' },
  sqlite3_step: { args: ['ptr'], returns: 'i32' },
  sqlite3_reset: { args: ['ptr'], returns: 'i32' },
  sqlite3_clear_bindings: { args: ['ptr'], returns: 'i32' },
  sqlite3_finalize: { args: ['ptr'], returns: 'i32' },
  sqlite3_stmt_readonly: { args: ['ptr'], returns: 'i32' },
  sqlite3_bind_parameter_count: { args: ['ptr'], returns: 'i32' },
  sqlite3_bind_parameter_name: { args: ['ptr', 'i32'], returns: 'cstring' },
  sqlite3_bind_int64: { args: ['ptr', 'i32', 'i64'], returns: 'i32' },
  sqlite3_bind_double: { args: ['ptr', 'i32', 'f64'], returns: 'i32' },
  sqlite3_bind_text: { args: ['ptr', 'i32', 'ptr', 'i32', 'ptr'], returns: 'i32' },
  sqlite3_bind_blob: { args: ['ptr', 'i32', 'ptr', 'i32', 'ptr'], returns: 'i32' },
  sqlite3_bind_null: { args: ['ptr', 'i32'], returns: 'i32' },
  sqlite3_column_count: { args: ['ptr'], returns: 'i32' },
  sqlite3_column_name: { args: ['ptr', 'i32'], returns: 'cstring' },
  sqlite3_column_type: { args: ['ptr', 'i32'], returns: 'i32' },
  sqlite3_column_int64: { args: ['ptr', 'i32'], returns: 'i64' },
  sqlite3_column_double: { args: ['ptr', 'i32'], returns: 'f64' },
  sqlite3_column_text: { args: ['ptr', 'i32'], returns: 'ptr' },
  sqlite3_column_blob: { args: ['ptr', 'i32'], returns: 'ptr' },
  sqlite3_column_bytes: { args: ['ptr', 'i32'], returns: 'i32' },
} as const

export type Sqlite3 = Library<typeof SYMBOLS>['symbols']

export const SQLITE_OK = 0
export const SQLITE_ROW = 100
export const SQLITE_DONE = 101
export const SQLITE_NOTADB = 26
export const OPEN_READONLY = 0x1
export const OPEN_READWRITE = 0x2
export const OPEN_CREATE = 0x4
export const OPEN_URI = 0x40
export const OPEN_FULLMUTEX = 0x10000
export const COLUMN_INTEGER = 1
export const COLUMN_FLOAT = 2
export const COLUMN_TEXT = 3
export const COLUMN_BLOB = 4

let loaded: { path: string; symbols: Sqlite3 } | null = null

/** dlopen once; asking for a different library later in the same process throws. */
export function sqlite3(path: string): Sqlite3 {
  if (loaded !== null) {
    if (loaded.path !== path) throw new Error('a different SQLite library is already loaded in this process')
    return loaded.symbols
  }
  let symbols: Sqlite3
  try {
    symbols = dlopen(path, SYMBOLS).symbols
  } catch {
    throw new SqliteError('the SQLite library is not a sqlite3mc build; run sam install', 'SQLITE_CANTOPEN', 14, 'library')
  }
  loaded = { path, symbols }
  return symbols
}
