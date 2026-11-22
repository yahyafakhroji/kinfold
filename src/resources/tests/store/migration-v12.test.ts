import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDatabase } from '../sqlite/test-support'
import { openStore } from '../../store/db'
import { readDisplaySettings, writeDisplaySettings } from '../../store/display-settings'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../store/schema'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-migrate-v12-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const payload = (kind: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ kind, ...extra })

/**
 * A v11 store with one session and four prompts:
 *   1: Stop fired twice, so two turn_end events (the later reply wins)
 *   2: its turn_end payload expired under events retention
 *   3: a turn_end with no reply text
 *   4: a turn_end whose payload is not JSON
 * plus an injection, an observer run and an observation, which must survive.
 */
function v11Database(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  const db = openTestDatabase(join(dataDir, 'memory.db'))
  db.run('PRAGMA journal_mode = WAL')
  for (const sql of MIGRATIONS.slice(0, 11)) db.run(sql)
  db.run('PRAGMA user_version = 11')
  db.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1)")
  db.run("INSERT INTO sessions (id, host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES (1, 'claude-code', 's1', 'org/repo', '/w', 100, 900)")
  for (const n of [1, 2, 3, 4]) {
    db.query('INSERT INTO prompts (session_id, prompt_number, text, occurred_at) VALUES (1, ?, ?, ?)').run(n, `prompt ${n}`, n * 100)
  }
  const event = db.query(`INSERT INTO events (event_id, session_id, prompt_number, kind, payload, content_hash, occurred_at, ingested_at, payload_expired_at)
    VALUES (?, 1, ?, ?, ?, 'h', ?, ?, ?)`)
  event.run('e1', 1, 'user_prompt', payload('user_prompt', { promptText: 'prompt 1' }), 100, 100, null)
  event.run('e2', 1, 'turn_end', payload('turn_end', { assistantText: 'first stop' }), 110, 110, null)
  event.run('e3', 1, 'turn_end', payload('turn_end', { assistantText: 'final reply <redacted rule="aws-key"/>' }), 120, 120, null)
  event.run('e4', 2, 'turn_end', JSON.stringify({ eventId: 'e4', kind: 'turn_end', expired: 'retention', expiredAt: 500 }), 210, 210, 500)
  event.run('e5', 4, 'turn_end', 'not json', 410, 410, null)
  event.run('e6', 3, 'turn_end', payload('turn_end'), 310, 310, null)
  db.run("INSERT INTO injections (session_id, host, host_session_id, project_key, observation_ids, channel, tokens, occurred_at) VALUES (1, 'claude-code', 's1', 'org/repo', '[7]', 'prompt', 40, 105)")
  db.run("INSERT INTO observer_runs (session_id, host, provider, model, status, event_count, started_at) VALUES (1, 'claude-code', 'claude-cli', 'haiku', 'succeeded', 2, 130)")
  db.run(`INSERT INTO observations (id, project_key, session_id, host, prompt_number, type, title, evidence, content_hash, occurred_at, created_at)
    VALUES (7, 'org/repo', 1, 'claude-code', 1, 'discovery', 'kept', 'tool-verified', 'oh', 100, 100)`)
  db.close()
}

test('migration 11 -> 12 backfills replies from live turn_end events and keeps every row', () => {
  const dataDir = join(root, 'data')
  v11Database(dataDir)
  const before = Date.now()
  const store = openStore(dataDir)
  try {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(12)
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    const replies = store.db.query<{ n: number; text: string; reply: string | null }, []>('SELECT prompt_number AS n, text, reply_text AS reply FROM prompts ORDER BY prompt_number').all()
    expect(replies).toEqual([
      { n: 1, text: 'prompt 1', reply: 'final reply <redacted rule="aws-key"/>' },
      { n: 2, text: 'prompt 2', reply: null },
      { n: 3, text: 'prompt 3', reply: null },
      { n: 4, text: 'prompt 4', reply: null },
    ])
    // The events keep their payloads: the observer still reads the reply there.
    expect((store.db.query("SELECT payload FROM events WHERE event_id = 'e3'").get() as { payload: string }).payload).toContain('final reply')
    expect(store.db.query('SELECT prompt_number AS promptNumber, held_out AS heldOut, related_count AS relatedCount, observation_ids AS ids FROM injections').all())
      .toEqual([{ promptNumber: null, heldOut: 0, relatedCount: 0, ids: '[7]' }])
    expect(store.db.query('SELECT input_tokens AS i, output_tokens AS o, status FROM observer_runs').all()).toEqual([{ i: null, o: null, status: 'succeeded' }])
    expect((store.db.query('SELECT count(*) AS n FROM observations').get() as { n: number }).n).toBe(1)
    expect((store.db.query('SELECT count(*) AS n FROM turn_usage').get() as { n: number }).n).toBe(0)
    expect((store.db.query('SELECT count(*) AS n FROM embedding_calls').get() as { n: number }).n).toBe(0)

    const settings = readDisplaySettings(store.db)
    expect(settings.showRecall).toBe(true)
    expect(settings.holdout).toBe(false)
    // Impact numbers start at the upgrade, and the page says since when.
    expect(settings.since).toBeGreaterThanOrEqual(before)
    expect(settings.since).toBeLessThanOrEqual(Date.now())
  } finally {
    store.db.close()
  }
})

test('a fresh store starts at the latest version with recall shown and the holdout off', () => {
  const store = openStore(join(root, 'fresh'))
  try {
    expect(readDisplaySettings(store.db)).toMatchObject({ showRecall: true, holdout: false })
    const saved = writeDisplaySettings(store.db, { holdout: true }, 5)
    expect(saved).toMatchObject({ showRecall: true, holdout: true })
    expect(writeDisplaySettings(store.db, { showRecall: false }, 6)).toMatchObject({ showRecall: false, holdout: true })
    // The upgrade date is not something a settings write may move.
    expect(readDisplaySettings(store.db).since).toBe(saved.since)
  } finally {
    store.db.close()
  }
})

test('turn_usage holds one row per turn and goes with its session', () => {
  const store = openStore(join(root, 'usage'))
  try {
    const db = store.db
    db.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1)")
    db.run("INSERT INTO sessions (id, host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES (1, 'claude-code', 's1', 'org/repo', '/w', 1, 1)")
    const insert = "INSERT INTO turn_usage (session_id, prompt_number, host, project_key, held_out, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tool_calls, duration_ms, occurred_at) VALUES (1, 1, 'claude-code', 'org/repo', 0, 10, 20, 30, 40, 2, 900, 5)"
    db.run(insert)
    expect(() => db.run(insert)).toThrow()
    db.run('DELETE FROM sessions WHERE id = 1')
    expect((db.query('SELECT count(*) AS n FROM turn_usage').get() as { n: number }).n).toBe(0)
  } finally {
    store.db.close()
  }
})
