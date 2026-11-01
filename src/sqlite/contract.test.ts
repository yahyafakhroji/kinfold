// One suite, two drivers: every case runs on bun:sqlite and on sqlite3mc, each
// on its own temp file, and the results must match. A difference is a driver
// bug unless docs/reference/sqlite-driver.md names it.

import { Database as BunDatabase } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDatabase } from './test-support'
import type { Database } from './types'

const dir = mkdtempSync(join(tmpdir(), 'sam-sqlite-contract-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const fresh = (open: (path: string) => Database): Database => open(join(dir, `db-${n++}.sqlite`))
const DRIVERS: Record<string, (path: string) => Database> = {
  'bun:sqlite': (path) => new BunDatabase(path, { create: true, strict: true }) as unknown as Database,
  sqlite3mc: (path) => openTestDatabase(path),
}

/** Runs `body` on both drivers and returns both results, errors included, for comparison. */
function both(body: (db: Database) => unknown): [unknown, unknown] {
  const run = (open: (path: string) => Database) => {
    const db = fresh(open)
    try {
      return { ok: body(db) }
    } catch (error: unknown) {
      const e = error as { name?: string; code?: string; errno?: number; message?: string }
      return { error: { name: e.name, code: e.code ?? null, errno: e.errno ?? null, message: e.message } }
    } finally {
      db.close()
    }
  }
  return [run(DRIVERS['bun:sqlite']!), run(DRIVERS.sqlite3mc!)]
}

const setup = (db: Database): void => {
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, a, b); CREATE TABLE u(x TEXT NOT NULL)')
}

const CASES: Record<string, (db: Database) => unknown> = {
  'run() returns changes and the last rowid': (db) => { setup(db); return [db.query('INSERT INTO t(a, b) VALUES ($a, $b)').run({ a: 1, b: 2 }), db.run('UPDATE t SET a = 5')] },
  'named binding: extra keys ignored, undefined is NULL, true is 1, 2.0 is an integer': (db) =>
    db.query('SELECT $a AS a, $b AS b, $c AS c, typeof($c) AS ct').get({ a: undefined, b: true, c: 2.0, unused: 9 }),
  'a missing named parameter throws': (db) => db.query('SELECT $a AS a, $b AS b').get({ a: 1 }),
  'positional binding, numbered and plain': (db) => [db.query('SELECT ?1 AS a, ?2 AS b').get(1, 'x'), db.query('SELECT ? AS a, ? AS b').all(...[2, 'y'])],
  'integers past 2^53 come back as lossy numbers, bigint binds exactly': (db) =>
    [db.query('SELECT 9007199254740993 AS x').get(), db.query('SELECT $x - 9007199254740992 AS d').get({ x: 9007199254740993n })],
  'reals, text (unicode, empty) and NULL': (db) => db.query("SELECT 1.5 AS r, 'café 🚀' AS t, '' AS e, NULL AS n").get(),
  'blobs round-trip from any typed array, empty ones too': (db) => {
    setup(db)
    const floats = new Float32Array([1, 2, 3, 4]).subarray(1, 3)
    db.query('INSERT INTO t(a, b) VALUES (?, ?)').run(floats, new Uint8Array(0))
    const row = db.query<{ a: Uint8Array; b: Uint8Array }, []>('SELECT a, b FROM t').get()!
    return [Array.from(new Float32Array(row.a.buffer.slice(row.a.byteOffset, row.a.byteOffset + row.a.byteLength))), row.b.length, row.a instanceof Uint8Array]
  },
  'get() with no row is null, all() is []': (db) => [db.query('SELECT 1 WHERE 0').get(), db.query('SELECT 1 WHERE 0').all()],
  'values() returns arrays': (db) => db.query('SELECT 1 AS x, 2 AS y UNION ALL SELECT 3, 4').values(),
  'a repeated column name keeps the last': (db) => db.query('SELECT 1 AS x, 2 AS x').get(),
  'query() caches per SQL text, prepare() does not': (db) => [db.query('SELECT 1') === db.query('SELECT 1'), db.prepare('SELECT 1') === db.prepare('SELECT 1')],
  'exec() runs several statements': (db) => { db.exec('CREATE TABLE a(x); INSERT INTO a VALUES (1); INSERT INTO a VALUES (2)'); return db.query('SELECT count(*) AS n FROM a').get() },
  'a constraint error carries the extended code': (db) => { setup(db); db.run('INSERT INTO t(id) VALUES (1)'); db.run('INSERT INTO t(id) VALUES (1)') },
  'a NOT NULL error carries its code': (db) => { setup(db); db.query('INSERT INTO u(x) VALUES (?)').run(null) },
  'transaction commits and returns the value': (db) => { setup(db); const out = db.transaction((v: number) => { db.query('INSERT INTO t(a) VALUES (?)').run(v); return v * 2 })(21); return [out, db.query('SELECT a FROM t').all()] },
  'a throw rolls back and rethrows': (db) => {
    setup(db)
    let message = ''
    try { db.transaction(() => { db.run('INSERT INTO t(a) VALUES (1)'); throw new Error('stop') })() } catch (e) { message = (e as Error).message }
    return [message, db.query('SELECT count(*) AS n FROM t').get()]
  },
  'a nested transaction rolls back alone': (db) => {
    setup(db)
    const inner = db.transaction(() => { db.run('INSERT INTO t(a) VALUES (2)'); throw new Error('inner') })
    db.transaction(() => { db.run('INSERT INTO t(a) VALUES (1)'); try { inner() } catch {} })()
    return db.query('SELECT a FROM t ORDER BY a').all()
  },
  'nested transactions commit together': (db) => {
    setup(db)
    db.transaction(() => { db.run('INSERT INTO t(a) VALUES (1)'); db.transaction(() => db.run('INSERT INTO t(a) VALUES (2)'))() })()
    return db.query('SELECT a FROM t ORDER BY a').all()
  },
  'FTS5 is available': (db) => {
    db.exec("CREATE VIRTUAL TABLE f USING fts5(body); INSERT INTO f(rowid, body) VALUES (1, 'csv parser drops quotes'), (2, 'deploy token')")
    return db.query("SELECT rowid FROM f WHERE f MATCH '\"quotes\"'").all()
  },
  'too few positional values throws': (db) => db.query('SELECT ? AS a, ? AS b').get(1),
  'too many positional values throws': (db) => db.query('SELECT ? AS a').get(1, 2),
  'one array argument binds positionally': (db) => db.query('SELECT ? AS a, ? AS b').get([1, 'x'] as never),
  'NaN binds NULL; Infinity binds REAL': (db) => db.query('SELECT ? AS a, typeof(?) AS b, ? AS c').get(Number.NaN, Number.NaN, Number.POSITIVE_INFINITY),
  'run() of a statement that writes nothing reports 0 changes': (db) => { setup(db); db.run('INSERT INTO t(a) VALUES (1)'); return db.query('SELECT 1').run().changes },
  'query() after finalize() of the cached statement works': (db) => { const first = db.query('SELECT 7 AS v'); first.finalize(); return db.query('SELECT 7 AS v').get() },
  'the pragmas the store sets read back the same': (db) => {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA user_version = 8')
    return ['journal_mode', 'foreign_keys', 'secure_delete', 'user_version'].map((p) => db.query(`PRAGMA ${p}`).get())
  },
}

describe('sqlite3mc behaves like bun:sqlite', () => {
  for (const [name, body] of Object.entries(CASES)) {
    test(name, () => {
      const [bun, ours] = both(body)
      expect(ours).toEqual(bun)
    })
  }
})

describe('pinned behaviour', () => {
  const ours = (body: (db: Database) => unknown) => both(body)[1] as { ok?: unknown; error?: { name: string; code: string; errno: number; message: string } }

  test('integers come back as numbers, errors as SQLiteError with the extended code', () => {
    expect(ours(CASES['integers past 2^53 come back as lossy numbers, bigint binds exactly']!).ok).toEqual([{ x: 9007199254740992 }, { d: 1 }])
    expect(ours(CASES['a constraint error carries the extended code']!).error).toMatchObject({ name: 'SQLiteError', code: 'SQLITE_CONSTRAINT_PRIMARYKEY', errno: 1555 })
    expect(ours(CASES['a missing named parameter throws']!).error?.message).toBe('Missing parameter "b"')
  })

  test('a closed database and a finalized statement refuse to run', () => {
    const db = fresh(DRIVERS.sqlite3mc!)
    const statement = db.prepare('SELECT 1 AS x')
    expect(statement.get()).toEqual({ x: 1 })
    statement.finalize()
    expect(() => statement.get()).toThrow('statement is finalized')
    db.close()
    db.close()
    expect(() => db.query('SELECT 1')).toThrow('database is closed')
  })

  test('the query cache drops old statements without breaking ones a caller still holds', () => {
    const db = fresh(DRIVERS.sqlite3mc!)
    const held = db.query<{ v: number }, []>('SELECT 42 AS v')
    for (let i = 0; i < 300; i++) db.query(`SELECT ${i} AS v`).get()
    expect(held.get()).toEqual({ v: 42 })
    db.close()
  })

  const vec0 = join(process.env.HOME ?? '', '.shared-agent-memory', 'lib', 'vec0.dylib')
  test.skipIf(process.platform !== 'darwin' || !existsSync(vec0))('vec0 loads, and SQL cannot load extensions afterwards', () => {
    const db = fresh(DRIVERS.sqlite3mc!)
    db.loadExtension(vec0)
    const a = new Float32Array([1, 0, 0, 0]), b = new Float32Array([0.6, 0.8, 0, 0])
    expect((db.query<{ d: number }, [Float32Array, Float32Array]>('SELECT vec_distance_cosine(?, ?) AS d').get(a, b)!.d)).toBeCloseTo(0.4, 6)
    expect(() => db.query('SELECT load_extension(?)').get(vec0)).toThrow()
    db.close()
  })
})
