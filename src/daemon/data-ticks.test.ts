import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type TempStore, T0, openTempStore, seedEvent, seedSession } from '../observer/test-support'
import { startDataTicks } from './data-ticks'

const DAY = 86_400_000

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('kinfold-data-ticks-')
})
afterEach(() => temp.cleanup())

test('a retention run that removes rows says so, so a kept size report is measured again; one that removes nothing does not', async () => {
  const session = seedSession(temp.store, 'claude-code', 'cc-1')
  seedEvent(temp.store, session, { kind: 'tool_result', at: T0, promptNumber: 1, tool: { name: 'Bash', output: 'old output', exitCode: 0 } })
  // Observed long ago: retention only expires what the observer is done with.
  temp.store.db.run("UPDATE events SET observer_state = 'done'")
  let removed = 0
  const ticks = startDataTicks({ db: temp.store.db, markerKey: () => ({ key: 'k', id: 'k' }) as never, log: () => {}, now: () => T0 + 400 * DAY, onRemoved: () => void (removed += 1), scanTickMs: 3_600_000, retentionTickMs: 3_600_000 })
  try {
    ticks.retentionTick()
    await Bun.sleep(10)
    expect(removed).toBe(1)
    ticks.retentionTick()
    await Bun.sleep(10)
    expect(removed).toBe(1)
  } finally {
    ticks.stop()
  }
})
