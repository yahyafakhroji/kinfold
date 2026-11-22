import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDatabase } from '../sqlite/test-support'
import { openStore } from '../../store/db'
import { listObserverSettings, upsertObserverSettings } from '../../store/observer-settings-store'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../store/schema'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-migrate-v14-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function v13Database(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  const db = openTestDatabase(join(dataDir, 'memory.db'))
  db.run('PRAGMA journal_mode = WAL')
  for (const sql of MIGRATIONS.slice(0, 13)) db.run(sql)
  db.run('PRAGMA user_version = 13')
  db.run("INSERT INTO observer_settings (host, provider, model, credential_ref, enabled, updated_at) VALUES ('opencode', 'openrouter', 'openrouter/auto', 'openrouter', 1, 5)")
  db.close()
}

test('migration 13 -> 14 adds an empty observer endpoint and keeps every settings row', () => {
  const dataDir = join(root, 'data')
  v13Database(dataDir)
  const store = openStore(dataDir)
  try {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(14)
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(store.db.query('SELECT host, endpoint FROM observer_settings').all()).toEqual([{ host: 'opencode', endpoint: null }])
    expect(listObserverSettings(store.db)).toEqual([{ host: 'opencode', provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, updatedAt: 5 }])
  } finally {
    store.db.close()
  }
})

test('the store keeps an endpoint, and a row saved without one clears it', () => {
  const dataDir = join(root, 'data')
  v13Database(dataDir)
  const store = openStore(dataDir)
  try {
    const saved = upsertObserverSettings(store.db, { host: 'codex', provider: 'openai-compatible', model: 'llama3.2', credentialRef: null, enabled: true, endpoint: 'http://127.0.0.1:11434/v1' }, 9)
    expect(saved).toEqual({ host: 'codex', provider: 'openai-compatible', model: 'llama3.2', credentialRef: null, enabled: true, updatedAt: 9, endpoint: 'http://127.0.0.1:11434/v1' })
    const cleared = upsertObserverSettings(store.db, { host: 'codex', provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true }, 10)
    expect(cleared).toEqual({ host: 'codex', provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, updatedAt: 10 })
  } finally {
    store.db.close()
  }
})
