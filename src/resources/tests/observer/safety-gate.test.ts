import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getSafety, listSafety, recordSafety } from '../store/observer-safety-store'
import { finishRun, markFailed, startRun } from '../store/observer-store'
import type { PlantedCheckResult } from './planted-check'
import type { CliObserverRunner, CliProbe } from './runners/cli-core'
import { createSafetyGate } from './safety-gate'
import { type TempStore, T0, openTempStore, seedEvent, seedSession, stateCounts } from './test-support'
import { ObserverError, type ObserverSettings } from './types'

let temp: TempStore
let logs: string[]
beforeEach(() => {
  temp = openTempStore('sam-safety-gate-')
  logs = []
})
afterEach(() => temp.cleanup())

const BINARY = '/Users/someone/.secret-dir/bin/codex'

function settings(provider: ObserverSettings['provider'], model = 'gpt-5-mini'): ObserverSettings {
  return { provider, model, credentialRef: null, enabled: true, source: 'host' }
}

interface Harness {
  probes: number
  runs: number
  checks: number
  built: string[]
}

/** A fake CLI runner whose probe answers `probe()` and whose model calls are only counted. */
function harness(probe: () => CliProbe | Promise<CliProbe>, verdict: () => PlantedCheckResult | Promise<PlantedCheckResult>) {
  const h: Harness = { probes: 0, runs: 0, checks: 0, built: [] }
  const runner: CliObserverRunner = {
    run: async () => { h.runs += 1; return { text: 'OK', model: 'm' } },
    runWithFiles: async () => { h.runs += 1; return { text: 'OK', model: 'm' } },
    probe: async () => { h.probes += 1; return probe() },
    listModels: async () => [],
  }
  const gate = createSafetyGate({
    db: temp.store.db,
    cliRunnerFor: (s) => { h.built.push(s.provider); return runner },
    plantedCheck: async () => { h.checks += 1; return verdict() },
    now: () => 500,
    log: (line) => logs.push(line),
  })
  return { h, gate }
}

const KEY = { provider: 'codex-cli', cliVersion: '0.50.0', binaryPath: BINARY } as const
const probeOk = (): CliProbe => ({ version: KEY.cliVersion, binaryPath: BINARY })

test('claude-cli and openrouter pass with no probe and no runner built', async () => {
  const { h, gate } = harness(probeOk, () => ({ ok: true }))
  expect(await gate.check(settings('claude-cli'))).toEqual({ ok: true })
  expect(await gate.check(settings('openrouter'))).toEqual({ ok: true })
  await gate.reportToolAttempt(settings('openrouter'))
  expect(h).toEqual({ probes: 0, runs: 0, checks: 0, built: [] })
  expect(listSafety(temp.store.db)).toEqual([])
})

test('no record: probes, runs the planted check once, records the pass and resets safety-failed events', async () => {
  const session = seedSession(temp.store, 'codex', 's1')
  const id = seedEvent(temp.store, session, { kind: 'turn_end', at: T0, promptNumber: 1, assistantText: 'x' })
  const runId = startRun(temp.store.db, { sessionId: session, host: 'codex', provider: 'codex-cli', model: 'm', eventCount: 1, startedAt: T0 })
  finishRun(temp.store.db, runId, 'failed', 'tool_attempt: a tool ran', T0)
  markFailed(temp.store.db, [id], T0)

  const { h, gate } = harness(probeOk, () => ({ ok: true }))
  expect(await gate.check(settings('codex-cli'))).toEqual({ ok: true })
  expect(h.probes).toBe(1)
  expect(h.checks).toBe(1)
  expect(getSafety(temp.store.db, KEY)).toEqual({ ...KEY, status: 'passed', errorClass: null, checkedAt: 500 })
  expect(stateCounts(temp.store, session)).toEqual({ pending: 1 })
})

test('no record and a failed planted check: records failed with the class and returns not-ok', async () => {
  const { h, gate } = harness(probeOk, () => ({ ok: false, errorClass: 'safety_check_failed' }))
  expect(await gate.check(settings('codex-cli'))).toEqual({ ok: false, errorClass: 'safety_check_failed' })
  expect(h.checks).toBe(1)
  expect(getSafety(temp.store.db, KEY)).toMatchObject({ status: 'failed', errorClass: 'safety_check_failed' })
})

test('a failed record returns not-ok with its class: probe only, no planted check, no model call', async () => {
  recordSafety(temp.store.db, KEY, 'failed', 'tool_attempt', 1)
  const { h, gate } = harness(probeOk, () => ({ ok: true }))
  expect(await gate.check(settings('codex-cli'))).toEqual({ ok: false, errorClass: 'tool_attempt' })
  expect(await gate.check(settings('codex-cli', 'another-model'))).toEqual({ ok: false, errorClass: 'tool_attempt' })
  expect(h.probes).toBe(2)
  expect(h.checks).toBe(0)
  expect(h.runs).toBe(0)
})

test('a passed record returns ok with no planted check', async () => {
  recordSafety(temp.store.db, KEY, 'passed', null, 1)
  const { h, gate } = harness(probeOk, () => ({ ok: false, errorClass: 'safety_check_failed' }))
  expect(await gate.check(settings('codex-cli'))).toEqual({ ok: true })
  expect(h.checks).toBe(0)
})

test('a changed version or binary path is a new key that gets its own planted check', async () => {
  recordSafety(temp.store.db, KEY, 'failed', 'tool_attempt', 1)
  let probe = { version: '0.51.0', binaryPath: BINARY }
  const { h, gate } = harness(() => probe, () => ({ ok: true }))
  expect(await gate.check(settings('codex-cli'))).toEqual({ ok: true })
  probe = { version: '0.51.0', binaryPath: '/opt/homebrew/bin/codex' }
  expect(await gate.check(settings('codex-cli'))).toEqual({ ok: true })
  expect(h.checks).toBe(2)
  // the first pass retires the old failed row, leaving one passed row per key
  expect(listSafety(temp.store.db)).toHaveLength(2)
})

test('concurrent checks for the same key share one planted check', async () => {
  let release: (result: PlantedCheckResult) => void = () => {}
  const verdict = new Promise<PlantedCheckResult>((resolve) => { release = resolve })
  const { h, gate } = harness(probeOk, () => verdict)
  const first = gate.check(settings('codex-cli'))
  const second = gate.check(settings('codex-cli'))
  await new Promise((resolve) => setImmediate(resolve))
  release({ ok: false, errorClass: 'safety_check_failed' })
  expect(await Promise.all([first, second])).toEqual([
    { ok: false, errorClass: 'safety_check_failed' },
    { ok: false, errorClass: 'safety_check_failed' },
  ])
  expect(h.checks).toBe(1)
  // After it settles the record answers, so a later check runs nothing new.
  expect(await gate.check(settings('codex-cli'))).toEqual({ ok: false, errorClass: 'safety_check_failed' })
  expect(h.checks).toBe(1)
})

test('a probe failure returns its class and records nothing', async () => {
  const { h, gate } = harness(() => { throw new ObserverError('cli_missing', 'codex not found on PATH') }, () => ({ ok: true }))
  expect(await gate.check(settings('opencode-cli'))).toEqual({ ok: false, errorClass: 'cli_missing' })
  expect(await gate.check(settings('opencode-cli'))).toEqual({ ok: false, errorClass: 'cli_missing' })
  expect(h.checks).toBe(0)
  expect(listSafety(temp.store.db)).toEqual([])
  // The repeated failure is logged once, not on every tick.
  expect(logs.filter((line) => line.includes('cli_missing'))).toHaveLength(1)
})

test('reportToolAttempt records failed/tool_attempt for the current key, and a probe failure records nothing', async () => {
  const { gate } = harness(probeOk, () => ({ ok: true }))
  await gate.reportToolAttempt(settings('codex-cli'))
  expect(getSafety(temp.store.db, KEY)).toEqual({ ...KEY, status: 'failed', errorClass: 'tool_attempt', checkedAt: 500 })

  const broken = harness(() => { throw new ObserverError('timeout', 'probe took too long') }, () => ({ ok: true }))
  await broken.gate.reportToolAttempt(settings('opencode-cli'))
  expect(listSafety(temp.store.db)).toHaveLength(1)
})

test('log lines carry provider, version, status and class, never the binary path', async () => {
  const { gate } = harness(probeOk, () => ({ ok: false, errorClass: 'tool_attempt' }))
  await gate.check(settings('codex-cli'))
  await gate.reportToolAttempt(settings('codex-cli'))
  expect(logs.length).toBeGreaterThan(0)
  for (const line of logs) {
    expect(line).not.toContain(BINARY)
    expect(line).not.toContain('secret-dir')
  }
  expect(logs[0]).toContain('provider=codex-cli')
  expect(logs[0]).toContain('version=0.50.0')
  expect(logs[0]).toContain('status=failed')
  expect(logs[0]).toContain('error=tool_attempt')
})

test('probeFailures lists the last probe failure per provider and drops it once a probe succeeds', async () => {
  let failing = true
  const { gate } = harness(() => {
    if (failing) throw new ObserverError('cli_missing', 'not found')
    return probeOk()
  }, () => ({ ok: true }))
  expect(gate.probeFailures()).toEqual([])
  await gate.check(settings('codex-cli'))
  expect(gate.probeFailures()).toEqual([{ provider: 'codex-cli', errorClass: 'cli_missing' }])
  expect(listSafety(temp.store.db)).toEqual([])
  failing = false
  expect(await gate.check(settings('codex-cli'))).toEqual({ ok: true })
  expect(gate.probeFailures()).toEqual([])
})
