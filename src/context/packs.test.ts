import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type TempStore, PROJECT, T0, openTempStore, seedSession } from '../observer/test-support'
import { readPack } from '../store/context-store'
import { PACK_MAX_AGE_MS, currentPack, rebuildProjectPacks, serveContext } from './packs'
import { NARRATIVE_MARKER, seedObservation, seedSummary } from './test-support'
import type { ContextRequest } from './types'

let temp: TempStore
let claude: number
let opencode: number
beforeEach(() => {
  temp = openTempStore('sam-packs-')
  claude = seedSession(temp.store, 'claude-code', 'cc-1')
  opencode = seedSession(temp.store, 'opencode', 'oc-1')
})
afterEach(() => temp.cleanup())

const NOW = T0 + 3_600_000
const request = (host: string, hostSessionId: string): ContextRequest => ({ host, cwd: '/work/repo', hostSessionId, channel: 'session_start' })
const injections = () => temp.store.db.query('SELECT * FROM injections ORDER BY id').all() as Record<string, unknown>[]

function seedLivePair(): number[] {
  return [
    seedObservation(temp.store, { sessionId: claude, projectKey: PROJECT, host: 'claude-code', title: 'Test suite passes: 197 tests across 16 files', at: T0 }),
    seedObservation(temp.store, { sessionId: claude, projectKey: PROJECT, host: 'claude-code', title: 'package.json defines test and hook scripts', at: T0 }),
    seedObservation(temp.store, { sessionId: opencode, projectKey: PROJECT, host: 'opencode', title: 'repo test suite: 197 tests passing across 16 files', at: T0 + 1000 }),
  ]
}

test('every host profile gets a pack built from all hosts, titles only', () => {
  seedLivePair()
  seedSummary(temp.store, opencode, 'Add the dashboard retry button', T0 + 2000)
  expect(rebuildProjectPacks(temp.store.db, PROJECT, NOW)).toBe(3)

  for (const profile of ['claude-code', 'opencode', 'default'] as const) {
    const pack = readPack(temp.store.db, PROJECT, profile)!
    expect(pack.body).toContain('[opencode ·')
    expect(pack.body).toContain('[claude-code ·')
    expect(pack.body).toContain('(also seen by claude-code)')
    expect(pack.body).toContain('Next steps from the latest session summary: Add the dashboard retry button')
    expect(pack.body).not.toContain(NARRATIVE_MARKER)
    expect([...pack.observationIds].sort()).toEqual([1, 2, 3])
    expect(pack.builtFromMaxId).toBe(3)
  }
})

test('another project\'s observations stay out', () => {
  seedLivePair()
  temp.store.db.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('other/repo', 'git-remote', 'other', 1)")
  seedObservation(temp.store, { sessionId: claude, projectKey: 'other/repo', host: 'claude-code', title: 'Other project secret plan', at: T0 })
  rebuildProjectPacks(temp.store.db, PROJECT, NOW)
  expect(readPack(temp.store.db, PROJECT, 'claude-code')!.body).not.toContain('Other project')
})

test('budgets differ per host profile', () => {
  for (let index = 0; index < 120; index += 1) {
    seedObservation(temp.store, { sessionId: claude, projectKey: PROJECT, host: 'claude-code', title: `Distinct finding ${index} in module q${index * 13}z`, at: T0 + index })
  }
  rebuildProjectPacks(temp.store.db, PROJECT, NOW)
  const tokens = (profile: 'claude-code' | 'opencode' | 'default') => readPack(temp.store.db, PROJECT, profile)!.tokenCount
  expect(tokens('claude-code')).toBeLessThanOrEqual(2000)
  expect(tokens('opencode')).toBeLessThanOrEqual(1200)
  expect(tokens('default')).toBeLessThanOrEqual(1500)
  expect(tokens('claude-code')).toBeGreaterThan(tokens('default'))
  expect(tokens('default')).toBeGreaterThan(tokens('opencode'))
})

test('a stored pack is served while fresh and rebuilt after a new observation or when its ages go stale', () => {
  seedLivePair()
  rebuildProjectPacks(temp.store.db, PROJECT, NOW)
  expect(currentPack(temp.store.db, PROJECT, 'opencode', NOW + 1000).rebuilt).toBe(false)

  seedObservation(temp.store, { sessionId: opencode, projectKey: PROJECT, host: 'opencode', title: 'Spool drain keeps event order', at: T0 + 5000 })
  const afterWrite = currentPack(temp.store.db, PROJECT, 'opencode', NOW + 2000)
  expect(afterWrite.rebuilt).toBe(true)
  expect(afterWrite.pack!.body).toContain('Spool drain keeps event order')
  expect(currentPack(temp.store.db, PROJECT, 'opencode', NOW + 3000).rebuilt).toBe(false)
  expect(currentPack(temp.store.db, PROJECT, 'opencode', NOW + 2000 + PACK_MAX_AGE_MS).rebuilt).toBe(true)
})

test('serving records one injection naming the host session, linked to its session row when it exists', () => {
  const ids = seedLivePair()
  const served = serveContext(temp.store.db, request('claude-code', 'cc-1'), PROJECT, NOW)
  expect(served.text).toContain('<shared-agent-memory>')
  expect([...served.observationIds].sort()).toEqual(ids)
  serveContext(temp.store.db, { ...request('opencode', 'oc-not-ingested-yet'), channel: 'request' }, PROJECT, NOW)

  expect(injections().map((row) => [row.session_id, row.host, row.host_session_id, row.channel, row.project_key])).toEqual([
    [claude, 'claude-code', 'cc-1', 'session_start', PROJECT],
    [null, 'opencode', 'oc-not-ingested-yet', 'request', PROJECT],
  ])
  expect(JSON.parse(injections()[0]!.observation_ids as string).sort()).toEqual(ids)
  expect(injections()[0]!.tokens).toBe(served.tokens)
})

test('an empty pack or an unknown project serves nothing and records no injection', () => {
  expect(serveContext(temp.store.db, request('claude-code', 'cc-1'), PROJECT, NOW)).toMatchObject({ text: '', observationIds: [], tokens: 0, injectionId: null })
  expect(serveContext(temp.store.db, request('claude-code', 'cc-1'), '/never/seen', NOW)).toMatchObject({ text: '', injectionId: null })
  expect(injections()).toEqual([])
  expect(temp.store.db.query("SELECT count(*) AS n FROM context_packs WHERE project_key = '/never/seen'").get()).toEqual({ n: 0 })
})
