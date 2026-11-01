import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDatabase } from '../sqlite/test-support'
import type { Database } from '../sqlite/types'
import { openStore } from './db'
import { insertMcpRead, mcpReadsSince } from './mcp-read-store'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-migrate-v6-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A populated v5 store: two observations with a link, a summary and two injections. */
function v5Database(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  const v5 = openTestDatabase(join(dataDir, 'memory.db'))
  v5.run('PRAGMA journal_mode = WAL')
  for (const sql of MIGRATIONS.slice(0, 5)) v5.run(sql)
  v5.run('PRAGMA user_version = 5')
  v5.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1)")
  v5.run("INSERT INTO sessions (host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES ('claude-code', 's', 'org/repo', '/w', 1, 2)")
  for (const [title, at] of [['older', 1], ['newer', 2]] as const) {
    v5.query(`INSERT INTO observations (project_key, session_id, host, type, title, evidence, content_hash, occurred_at, created_at)
              VALUES ('org/repo', 1, 'claude-code', 'discovery', ?, 'tool-verified', ?, ?, ?)`).run(title, `h-${title}`, at, at)
  }
  v5.run("INSERT INTO observation_links (from_id, to_id, kind, created_at) VALUES (2, 1, 'confirms', 3)")
  v5.run("INSERT INTO summaries (session_id, prompt_number, request, next_steps, occurred_at, updated_at) VALUES (1, 1, 'r', 'n', 1, 1)")
  v5.run(`INSERT INTO injections (session_id, host, host_session_id, project_key, observation_ids, channel, tokens, occurred_at)
          VALUES (1, 'claude-code', 's', 'org/repo', '[1,2]', 'session_start', 50, 1), (NULL, 'opencode', 'o', 'org/repo', '[2]', 'request', 30, 2)`)
  v5.close()
}

const count = (db: Database, table: string): number => (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

test('migration 5 -> 6 upgrades a populated v5 store in place: rows kept, duration_ms null, mcp_reads empty', () => {
  const dataDir = join(root, 'data')
  v5Database(dataDir)
  const startedAt = performance.now()
  const store = openStore(dataDir)
  const ms = performance.now() - startedAt
  try {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(6)
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(ms).toBeLessThan(1_000)
    expect(['observations', 'summaries', 'injections', 'observation_links', 'sessions'].map((table) => count(store.db, table))).toEqual([2, 1, 2, 1, 1])
    expect(store.db.query('SELECT channel, tokens, duration_ms AS durationMs FROM injections ORDER BY id').all()).toEqual([
      { channel: 'session_start', tokens: 50, durationMs: null },
      { channel: 'request', tokens: 30, durationMs: null },
    ])
    expect(count(store.db, 'mcp_reads')).toBe(0)
    const columns = (store.db.query("SELECT name FROM pragma_table_info('mcp_reads') ORDER BY cid").all() as { name: string }[]).map((row) => row.name)
    expect(columns).toEqual(['id', 'occurred_at', 'project_key', 'host', 'tool', 'returned_ids', 'rows', 'ms', 'status'])
    expect(columns.some((name) => /query|text|arg/i.test(name))).toBe(false)
    const indexes = (store.db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('injections_by_time', 'observations_by_created', 'mcp_reads_by_time', 'mcp_reads_by_project') ORDER BY name").all() as { name: string }[])
    expect(indexes.map((row) => row.name)).toEqual(['injections_by_time', 'mcp_reads_by_project', 'mcp_reads_by_time', 'observations_by_created'])
  } finally {
    store.db.close()
  }
})

test('after the upgrade, mcp_reads takes a row and refuses an unknown tool', () => {
  const dataDir = join(root, 'data')
  v5Database(dataDir)
  const store = openStore(dataDir)
  try {
    insertMcpRead(store.db, { tool: 'get_observations', projectKey: 'org/repo', host: null, returnedIds: [1, 2], rows: 2, ms: 1.6, status: 'ok' }, 10)
    expect(mcpReadsSince(store.db, 0)).toEqual([
      { occurredAt: 10, projectKey: 'org/repo', host: null, tool: 'get_observations', returnedIds: [1, 2], rows: 2, ms: 2, status: 'ok' },
    ])
    expect(() => store.db.run("INSERT INTO mcp_reads (occurred_at, project_key, tool, rows, ms, status) VALUES (1, 'k', 'write_things', 0, 0, 'ok')")).toThrow()
  } finally {
    store.db.close()
  }
})
