import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openStore } from '../store/db'
import { type TempStore, T0, fakeRunner, openTempStore, seedEvent, seedSession } from '../observer/test-support'
import type { SafetyGate } from '../observer/safety-gate'
import { type RunningDaemon, startDaemon } from './daemon'

let temp: TempStore
let daemon: RunningDaemon | null
beforeEach(() => {
  temp = openTempStore('sam-daemon-observer-')
  daemon = null
})
afterEach(async () => {
  if (daemon !== null) await daemon.stop()
  temp.cleanup()
})

test('without observer options the daemon never observes', () => {
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  expect(daemon.observer).toBeNull()
})

test('with observer options the daemon recovers interrupted work, then observes due sessions on start', async () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  const id = seedEvent(temp.store, session, { kind: 'turn_end', at: T0, promptNumber: null })
  temp.store.db.run(`UPDATE events SET observer_state = 'processing' WHERE event_id = '${id}'`)

  const runner = fakeRunner([(prompt) => JSON.stringify({ observations: [{ type: 'change', title: 'Turn ended', narrative: '', facts: [], files: [], evidence: { strength: 'interpretation', sourceEventIds: [prompt.eventIds[0]] } }], summary: null })])
  const logs: string[] = []
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line), observer: { runnerFor: () => runner, tickMs: 60_000 } })
  await daemon.observer!.whenIdle()

  expect(runner.prompts).toHaveLength(1)
  expect(logs).toContain('observer recovered events=1 runs=0')
  expect(logs.some((line) => line.includes('observer=on'))).toBe(true)
  const reader = openStore(temp.dataDir)
  try {
    expect(reader.db.query('SELECT observer_state FROM events').all()).toEqual([{ observer_state: 'done' }])
    expect(reader.db.query('SELECT title, evidence FROM observations').all()).toEqual([{ title: 'Turn ended', evidence: 'interpretation' }])
  } finally {
    reader.db.close()
  }
})

test('startDaemon passes the safety gate through: a blocked CLI observer is blocked end to end', async () => {
  const session = seedSession(temp.store, 'codex', 'c1')
  seedEvent(temp.store, session, { kind: 'turn_end', at: T0, promptNumber: 1, assistantText: 'x' })
  temp.store.db.run("INSERT INTO observer_settings (host, provider, model, enabled, updated_at) VALUES ('codex', 'codex-cli', 'gpt-5-mini', 1, 1)")
  const runner = fakeRunner(['{}'])
  const gateDbs: unknown[] = []
  const safety = (db: unknown): SafetyGate => {
    gateDbs.push(db)
    return { check: async () => ({ ok: false, errorClass: 'safety_check_failed' }), reportToolAttempt: async () => {}, probeFailures: () => [] }
  }
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {}, observer: { runnerFor: () => runner, safety, tickMs: 60_000, resetCheckMs: 60_000 } })
  await daemon.observer!.whenIdle()

  expect(gateDbs).toHaveLength(1)
  expect(runner.prompts).toEqual([])
  const reader = openStore(temp.dataDir)
  try {
    expect(reader.db.query('SELECT observer_state FROM events').all()).toEqual([{ observer_state: 'pending' }])
    expect(reader.db.query('SELECT count(*) AS n FROM observer_runs').get()).toEqual({ n: 0 })
  } finally {
    reader.db.close()
  }
})

test('GET /observer/settings reports the gate\'s probe failures as provider and class only, and an empty list without a gate', async () => {
  const safety = (): SafetyGate => ({
    check: async () => ({ ok: true }),
    reportToolAttempt: async () => {},
    probeFailures: () => [{ provider: 'opencode-cli', errorClass: 'cli_missing' }],
  })
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {}, observer: { runnerFor: () => fakeRunner([]), safety, tickMs: 60_000, resetCheckMs: 60_000 } })
  const token = readFileSync(join(temp.dataDir, 'daemon.token'), 'utf8').trim()
  const view = (await (await fetch(`http://127.0.0.1:${daemon.port}/observer/settings`, { headers: { authorization: `Bearer ${token}` } })).json()) as { probe: unknown }
  expect(view.probe).toEqual([{ provider: 'opencode-cli', errorClass: 'cli_missing' }])
  await daemon.stop()
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const plain = (await (await fetch(`http://127.0.0.1:${daemon.port}/observer/settings`, { headers: { authorization: `Bearer ${readFileSync(join(temp.dataDir, 'daemon.token'), 'utf8').trim()}` } })).json()) as { probe: unknown }
  expect(plain.probe).toEqual([])
})
