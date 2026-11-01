import { afterEach, beforeEach, expect, test } from 'bun:test'
import { openStore } from '../store/db'
import { type TempStore, T0, fakeRunner, openTempStore, seedEvent, seedSession } from '../observer/test-support'
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
