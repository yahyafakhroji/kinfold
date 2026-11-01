import { afterEach, beforeEach, expect, test } from 'bun:test'
import { seedObservation, seedSummary } from '../context/test-support'
import { type TempStore, T0, openTempStore, seedEvent, seedSession } from '../observer/test-support'
import { DEFAULT_RETENTION, readDataSettings, writeDataSettings } from '../store/data-settings-store'
import { insertPrompt } from '../store/writes'
import { DAY_MS, applyRetention, describePreview, mergeRetention, previewRetention } from './retention'

let temp: TempStore
let session: number
const NOW = T0 + 40 * DAY_MS
const OLD = NOW - 31 * DAY_MS
beforeEach(() => {
  temp = openTempStore('sam-retention-preview-')
  session = seedSession(temp.store, 'claude-code', 'cc-1')
})
afterEach(() => temp.cleanup())

const db = () => temp.store.db
const oldEvent = (output: string, state: string, attempts: number): string => {
  const id = seedEvent(temp.store, session, { kind: 'tool_result', at: OLD, promptNumber: 1, tool: { name: 'Bash', output, exitCode: 0 } })
  db().query('UPDATE events SET observer_state = ?, observer_attempts = ? WHERE event_id = ?').run(state, attempts, id)
  return id
}

test('mergeRetention lays a change over the stored settings without touching them', () => {
  const current = { retention: DEFAULT_RETENTION, warnBytes: 10 }
  expect(mergeRetention(current, { retention: { prompts: 3 } })).toEqual({ retention: { ...DEFAULT_RETENTION, prompts: 3 }, warnBytes: 10 })
  expect(mergeRetention(current, { warnBytes: 99 })).toEqual({ retention: DEFAULT_RETENTION, warnBytes: 99 })
  expect(current.retention.prompts).toBeNull()
})

test('the preview counts done and exhausted events only, writes nothing, and matches what a save then expires', () => {
  oldEvent('qxdone', 'done', 1)
  oldEvent('qxexhausted', 'failed', 3)
  oldEvent('qxretryable', 'failed', 1)
  oldEvent('qxpending', 'pending', 0)
  insertPrompt(db(), { sessionId: session, promptNumber: 1, text: 'qxoldprompt', occurredAt: NOW - 10 * DAY_MS })
  seedObservation(temp.store, { sessionId: session, projectKey: 'org/repo', host: 'claude-code', title: 'Old fact', at: NOW - 10 * DAY_MS })
  seedObservation(temp.store, { sessionId: session, projectKey: 'org/repo', host: 'claude-code', title: 'New fact', at: NOW })
  seedSummary(temp.store, session, 'next qx', NOW - 10 * DAY_MS)
  const before = readDataSettings(db())

  const change = { retention: { prompts: 7, observations: 7 } }
  const preview = previewRetention(db(), change, NOW)
  expect(preview.settings.retention).toEqual({ ...DEFAULT_RETENTION, prompts: 7, observations: 7 })
  expect(preview.tables.events.rows).toBe(2)
  expect(preview.tables.events.bytes).toBeGreaterThan('qxdone'.length + 'qxexhausted'.length)
  expect(preview.tables.prompts).toEqual({ rows: 1, bytes: 'qxoldprompt'.length })
  expect(preview.tables.observations.rows).toBe(1)
  expect(preview.tables.observations.bytes).toBeGreaterThan(0)
  expect(preview.tables.summaries).toEqual({ rows: 0, bytes: 0 })

  expect(readDataSettings(db())).toEqual(before)
  expect(db().query('SELECT count(*) AS n FROM events WHERE payload_expired_at IS NULL').get()).toEqual({ n: 4 })
  expect(db().query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 2 })

  writeDataSettings(db(), change, NOW)
  expect(applyRetention(db(), NOW)).toMatchObject({ events: 2, prompts: 1, observations: 1, summaries: 0 })
  expect(previewRetention(db(), change, NOW).tables).toMatchObject({ events: { rows: 0 }, prompts: { rows: 0 }, observations: { rows: 0 } })
})

test('a table set to keep previews as zero, and the log line carries counts only', () => {
  oldEvent('qxdone', 'done', 1)
  expect(previewRetention(db(), { retention: { events: null } }, NOW).tables.events).toEqual({ rows: 0, bytes: 0 })
  const line = describePreview(previewRetention(db(), {}, NOW))
  expect(line).toMatch(/^data retention preview events=1 prompts=0 observations=0 summaries=0 ms=\d+$/)
  expect(line).not.toContain('qx')
})
