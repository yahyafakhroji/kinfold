import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDatabase } from '../sqlite/test-support'
import { openStore } from './db'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema'
import { promptTextHash } from './summary-share'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-migrate-v7-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const NOTICE = 'Worker finished. Read its report.'

/**
 * A populated v6 store. Project org/repo: the notice summarized three times
 * (sessions 1 and 2, one with odd whitespace), a unique prompt, and one more
 * copy of the notice without a summary. Project org/other: the notice once.
 * Session 1 prompt 9 has expired text. A finding points at a duplicate.
 */
function v6Database(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  const v6 = openTestDatabase(join(dataDir, 'memory.db'))
  v6.run('PRAGMA journal_mode = WAL')
  for (const sql of MIGRATIONS.slice(0, 6)) v6.run(sql)
  v6.run('PRAGMA user_version = 6')
  v6.run(`INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1), ('org/other', 'git-remote', 'other', 1)`)
  v6.run(`INSERT INTO sessions (host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES
    ('claude-code', 's1', 'org/repo', '/w', 1, 2), ('opencode', 's2', 'org/repo', '/w', 1, 2), ('claude-code', 's3', 'org/other', '/w', 1, 2)`)
  const prompts: [number, number, string, number, number | null][] = [
    [1, 1, NOTICE, 100, null], [1, 2, 'unique request', 200, null], [1, 3, `  ${NOTICE.replace(' ', '\n  ')}`, 300, null],
    [2, 1, NOTICE, 400, null], [2, 2, NOTICE, 500, null], [3, 1, NOTICE, 600, null], [1, 9, '<expired/>', 50, 60],
  ]
  for (const [session, n, text, at, expired] of prompts) {
    v6.query('INSERT INTO prompts (session_id, prompt_number, text, occurred_at, text_expired_at) VALUES (?, ?, ?, ?, ?)').run(session, n, text, at, expired)
  }
  const summaries: [number, number, string, number][] = [[1, 1, 'first', 110], [1, 2, 'unique', 210], [1, 3, 'third', 310], [2, 1, 'fourth', 410], [3, 1, 'other', 610], [1, 9, 'expired', 55]]
  for (const [session, n, request, at] of summaries) {
    v6.query('INSERT INTO summaries (session_id, prompt_number, request, occurred_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(session, n, request, at, at)
  }
  v6.run("INSERT INTO redaction_findings (table_name, row_id, rule, rule_version, found_at, action) VALUES ('summaries', '3', 'r', 1, 1, 'pending'), ('summaries', '1', 'r', 1, 1, 'pending')")
  v6.close()
}

test('migration 6 -> 7 backfills hashes and collapses duplicate summaries per project, keeping the earliest with right counts', () => {
  const dataDir = join(root, 'data')
  v6Database(dataDir)
  const startedAt = performance.now()
  const store = openStore(dataDir)
  const ms = performance.now() - startedAt
  try {
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(ms).toBeLessThan(1_000)
    const rows = store.db.query('SELECT id, session_id AS s, prompt_number AS n, request, repeat_count AS count, last_seen_at AS seen FROM summaries ORDER BY id').all()
    expect(rows).toEqual([
      { id: 1, s: 1, n: 1, request: 'first', count: 3, seen: 400 },
      { id: 2, s: 1, n: 2, request: 'unique', count: 1, seen: 210 },
      { id: 5, s: 3, n: 1, request: 'other', count: 1, seen: 610 },
      { id: 6, s: 1, n: 9, request: 'expired', count: 1, seen: 55 },
    ])
    const prompts = store.db.query('SELECT session_id AS s, prompt_number AS n, summary_id AS summary, text_hash AS hash FROM prompts ORDER BY id').all() as { summary: number | null; hash: string | null }[]
    expect(prompts.map((row) => row.summary)).toEqual([1, 2, 1, 1, null, 5, 6])
    expect(prompts.map((row) => row.hash)).toEqual([
      promptTextHash(NOTICE), promptTextHash('unique request'), promptTextHash(NOTICE), promptTextHash(NOTICE), promptTextHash(NOTICE), promptTextHash(NOTICE), null,
    ])
    expect(store.db.query('SELECT row_id AS id FROM redaction_findings ORDER BY id').all()).toEqual([{ id: '1' }])
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    store.db.close()
  }
})

test('migration 7 on an empty v6 store adds the columns and changes nothing else', () => {
  const dataDir = join(root, 'empty')
  mkdirSync(dataDir, { recursive: true })
  const v6 = openTestDatabase(join(dataDir, 'memory.db'))
  for (const sql of MIGRATIONS.slice(0, 6)) v6.run(sql)
  v6.run('PRAGMA user_version = 6')
  v6.close()
  const store = openStore(dataDir)
  try {
    const columns = (table: string) => store.db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => row.name)
    expect(columns('prompts')).toEqual(expect.arrayContaining(['text_hash', 'summary_id']))
    expect(columns('summaries')).toEqual(expect.arrayContaining(['repeat_count', 'last_seen_at']))
  } finally {
    store.db.close()
  }
})
