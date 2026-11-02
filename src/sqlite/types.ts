// The database surface every process uses. It is the subset of
// bun:sqlite the code called before the switch, with the same signatures, so
// call sites only changed their import. src/sqlite/contract.test.ts runs the
// same cases against both drivers.

/** Any typed array binds as a BLOB of its bytes, as in bun:sqlite. */
export type BindValue = string | number | bigint | boolean | null | undefined | ArrayBufferView
/** Positional values, or one object of named values (`$name` in SQL, `name` in the object). */
export type Bindings = BindValue[] | Record<string, BindValue>
export type BindArgs<P extends Bindings = Bindings> = P extends BindValue[] ? P : [P]

export interface RunResult {
  changes: number
  lastInsertRowid: number
}

export interface Statement<Row = unknown, Params extends Bindings = Bindings> {
  get(...params: BindArgs<Params>): Row | null
  all(...params: BindArgs<Params>): Row[]
  values(...params: BindArgs<Params>): unknown[][]
  run(...params: BindArgs<Params>): RunResult
  finalize(): void
}

export interface Database {
  /** Cached per SQL text; finalized on close. */
  query<Row = unknown, Params extends Bindings = Bindings>(sql: string): Statement<Row, Params>
  /** Not cached: the caller finalizes it. */
  prepare<Row = unknown, Params extends Bindings = Bindings>(sql: string): Statement<Row, Params>
  run(sql: string, ...params: BindArgs): RunResult
  /** One or more statements, no parameters. */
  exec(sql: string): void
  /** BEGIN/COMMIT, or a savepoint inside another transaction; a throw rolls back and rethrows. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R
  loadExtension(path: string): void
  close(): void
}

export type SqliteErrorKind = 'sqlite' | 'library' | 'no_key' | 'bad_key' | 'closed' | 'maintenance'

/** Named like bun:sqlite's error. Callers log `name` and `code`: the message can quote SQL, and SQL can quote prompt terms. */
export class SqliteError extends Error {
  constructor(message: string, readonly code: string, readonly errno: number, readonly kind: SqliteErrorKind = 'sqlite') {
    super(message)
    this.name = 'SQLiteError'
  }
}
