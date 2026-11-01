import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLITE3MC_LIB_ENV } from '../sqlite/library'
import { openStore } from '../store/db'
import { upsertProject, upsertSession } from '../store/writes'
import { fetchContext } from './client'
import { readStoredContext } from './fallback'
import { rebuildProjectPacks } from './packs'
import { seedObservation } from './test-support'

const CWD = '/work/fallback-repo'
const NOW = 1_792_900_000_000
const noGit = () => null

let root: string
let dataDir: string
let logs: string[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-fallback-'))
  dataDir = join(root, 'data')
  logs = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A store with one project keyed by path, one observation and built packs; closed afterwards like a stopped daemon. */
function seedStoreAndClose(): void {
  const store = openStore(dataDir)
  try {
    upsertProject(store.db, { key: CWD, kind: 'path', displayName: 'fallback-repo' }, NOW)
    const session = upsertSession(store.db, { host: 'claude-code', hostSessionId: 's', projectKey: CWD, cwd: CWD, occurredAt: NOW })
    seedObservation(store, { sessionId: session, projectKey: CWD, host: 'claude-code', title: 'Fallback serves stored packs', at: NOW })
    rebuildProjectPacks(store.db, CWD, NOW)
  } finally {
    store.db.close()
  }
}

/**
 * The file set plus a content hash of every file but -shm. The -shm file is
 * SQLite's WAL index: any reader, read-only included, updates its read marks
 * there. It holds no database content, so it is listed but not hashed.
 */
function snapshot(): Record<string, string> {
  return Object.fromEntries(readdirSync(dataDir).map((name) => {
    const path = join(dataDir, name)
    if (name.endsWith('-shm')) return [name, 'wal-index']
    return [name, `${statSync(path).size}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`]
  }))
}

function injectionCount(): number {
  const store = openStore(dataDir)
  try {
    return (store.db.query('SELECT count(*) AS n FROM injections').get() as { n: number }).n
  } finally {
    store.db.close()
  }
}

test('the fallback serves the stored pack read-only and writes nothing', () => {
  seedStoreAndClose()
  const before = snapshot()
  const result = readStoredContext(dataDir, { host: 'claude-code', cwd: CWD }, { budgetMs: 300, git: noGit, log: (line) => logs.push(line) })

  expect(result!.text).toContain('Fallback serves stored packs (#1)')
  expect(result!.observationIds).toEqual([1])
  expect(snapshot()).toEqual(before)
  expect(logs).toEqual([expect.stringContaining('injection not recorded (read-only path)')])
  expect(logs.join('\n')).not.toContain('Fallback serves stored packs')
  expect(injectionCount()).toBe(0)
})

test('the fallback reads the host profile pack and returns null for an unknown project or a missing database', () => {
  expect(readStoredContext(dataDir, { host: 'claude-code', cwd: CWD }, { budgetMs: 300, git: noGit })).toBeNull()
  expect(existsSync(dataDir)).toBe(false)
  seedStoreAndClose()
  expect(readStoredContext(dataDir, { host: 'opencode', cwd: CWD }, { budgetMs: 300, git: noGit })!.text).toContain('[claude-code ·')
  expect(readStoredContext(dataDir, { host: 'claude-code', cwd: '/elsewhere' }, { budgetMs: 300, git: noGit })).toBeNull()
})

test('with the daemon down, fetchContext falls back to the stored pack within the budget', async () => {
  seedStoreAndClose()
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: 1 }))
  writeFileSync(join(dataDir, 'daemon.token'), 'a'.repeat(64))
  const before = snapshot()
  const fetched = await fetchContext(dataDir, { host: 'claude-code', cwd: CWD, hostSessionId: 's', channel: 'session_start' }, { log: (line) => logs.push(line) })

  expect(fetched.source).toBe('fallback')
  expect(fetched.result!.text).toContain('Fallback serves stored packs')
  expect(fetched.ms).toBeLessThanOrEqual(300)
  expect(snapshot()).toEqual(before)
  expect(logs.some((line) => line.includes('daemon unreachable'))).toBe(true)
})

test('when the store cannot be opened the log says why, with our library message and no SQL', () => {
  seedStoreAndClose()
  const saved = process.env[SQLITE3MC_LIB_ENV]
  process.env[SQLITE3MC_LIB_ENV] = join(dataDir, 'no-such-library.dylib')
  try {
    expect(readStoredContext(dataDir, { host: 'claude-code', cwd: CWD }, { budgetMs: 300, git: noGit, log: (line) => logs.push(line) })).toBeNull()
  } finally {
    process.env[SQLITE3MC_LIB_ENV] = saved
  }
  expect(logs).toEqual([`context fallback: database could not be opened read-only (SQLITE_CANTOPEN: ${SQLITE3MC_LIB_ENV} names a missing file)`])
})
