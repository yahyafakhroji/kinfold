import { afterEach, beforeEach, expect, test } from 'bun:test'
import { seedObservation } from '../context/test-support'
import { type TempStore, T0, openTempStore, seedEvent, seedSession } from '../observer/test-support'
import { DEFAULT_RETENTION, readDataSettings, writeDataSettings } from '../store/data-settings-store'
import { insertFinding } from '../store/findings-store'
import { PROMPT_EXPIRED_MARKER } from '../store/retention-store'
import { insertPrompt } from '../store/writes'
import { DAY_MS, applyRetention, describeRetention } from './retention'

let temp: TempStore
let session: number
const NOW = T0 + 40 * DAY_MS
beforeEach(() => {
  temp = openTempStore('sam-retention-')
  session = seedSession(temp.store, 'claude-code', 'cc-1')
})
afterEach(() => temp.cleanup())

const row = (sql: string) => temp.store.db.query(sql).get() as Record<string, unknown>

test('defaults: event payloads 30 days, everything else kept', () => {
  expect(readDataSettings(temp.store.db)).toEqual({ retention: DEFAULT_RETENTION, warnBytes: 256 * 1024 * 1024 })
  expect(DEFAULT_RETENTION).toEqual({ events: 30, prompts: null, observations: null, summaries: null })
})

test('an expired payload becomes a marker, the row and metadata stay, a fresh one is kept, and a rerun changes nothing', () => {
  const old = seedEvent(temp.store, session, { kind: 'tool_result', at: NOW - 31 * DAY_MS, promptNumber: 1, tool: { name: 'Bash', output: 'qxoldpayload', exitCode: 0 } })
  const fresh = seedEvent(temp.store, session, { kind: 'tool_result', at: NOW - DAY_MS, promptNumber: 1, tool: { name: 'Bash', output: 'qxfreshpayload', exitCode: 0 } })
  insertFinding(temp.store.db, { table: 'events', rowId: old, field: 'tool.output', rule: 'key_fragment', ruleVersion: 2, matches: 1, foundAt: T0 })
  temp.store.db.query("UPDATE events SET observer_state = 'done'").run()

  const first = applyRetention(temp.store.db, NOW)
  expect(first).toMatchObject({ events: 1, prompts: 0, observations: 0, summaries: 0, findingsExpired: 1 })
  const expired = row(`SELECT kind, tool_name, content_hash, occurred_at, payload, payload_expired_at FROM events WHERE event_id = '${old}'`)
  expect(JSON.parse(String(expired.payload))).toEqual({ eventId: old, kind: 'tool_result', expired: 'retention', expiredAt: NOW })
  expect(expired).toMatchObject({ kind: 'tool_result', tool_name: 'Bash', occurred_at: NOW - 31 * DAY_MS, payload_expired_at: NOW })
  expect(String(row(`SELECT payload FROM events WHERE event_id = '${fresh}'`).payload)).toContain('qxfreshpayload')
  expect(row("SELECT action FROM redaction_findings").action).toBe('expired')

  const second = applyRetention(temp.store.db, NOW + 1)
  expect(second).toMatchObject({ events: 0, prompts: 0, observations: 0, summaries: 0 })
  expect(describeRetention(second)).toBeNull()
  expect(JSON.parse(String(row(`SELECT payload FROM events WHERE event_id = '${old}'`).payload)).expiredAt).toBe(NOW)
})

test('an old payload the observer still needs is kept; one it gave up on expires', () => {
  const at = NOW - 31 * DAY_MS
  const seed = (marker: string): string => seedEvent(temp.store, session, { kind: 'tool_result', at, promptNumber: 1, tool: { name: 'Bash', output: marker, exitCode: 0 } })
  const pending = seed('qxpending')
  const retryable = seed('qxretryable')
  const exhausted = seed('qxexhausted')
  const set = (id: string, state: string, attempts: number): void => {
    temp.store.db.query('UPDATE events SET observer_state = ?, observer_attempts = ? WHERE event_id = ?').run(state, attempts, id)
  }
  set(retryable, 'failed', 1)
  set(exhausted, 'failed', 3)

  expect(applyRetention(temp.store.db, NOW)).toMatchObject({ events: 1 })
  const payload = (id: string): string => String(row(`SELECT payload FROM events WHERE event_id = '${id}'`).payload)
  expect(payload(pending)).toContain('qxpending')
  expect(payload(retryable)).toContain('qxretryable')
  expect(payload(exhausted)).not.toContain('qxexhausted')
})

test('prompts, observations and summaries follow their own settings', () => {
  insertPrompt(temp.store.db, { sessionId: session, promptNumber: 1, text: 'qxoldprompt', occurredAt: NOW - 10 * DAY_MS })
  const oldObservation = seedObservation(temp.store, { sessionId: session, projectKey: 'org/repo', host: 'claude-code', title: 'Old fact', at: NOW - 10 * DAY_MS })
  const newObservation = seedObservation(temp.store, { sessionId: session, projectKey: 'org/repo', host: 'claude-code', title: 'New fact', at: NOW })
  expect(applyRetention(temp.store.db, NOW)).toMatchObject({ prompts: 0, observations: 0 })

  writeDataSettings(temp.store.db, { retention: { prompts: 7, observations: 7 } }, NOW)
  const outcome = applyRetention(temp.store.db, NOW)
  expect(outcome).toMatchObject({ prompts: 1, observations: 1, summaries: 0 })
  expect(row('SELECT text, prompt_number FROM prompts')).toEqual({ text: PROMPT_EXPIRED_MARKER, prompt_number: 1 })
  expect(temp.store.db.query('SELECT id FROM observations').all()).toEqual([{ id: newObservation }])
  expect(oldObservation).not.toBe(newObservation)
  expect(describeRetention(outcome)).toStartWith('data retention events=0 prompts=1 observations=1')
  expect(applyRetention(temp.store.db, NOW)).toMatchObject({ prompts: 0, observations: 0 })
})

test('keep (null) turns a table off again', () => {
  writeDataSettings(temp.store.db, { retention: { events: null }, warnBytes: 1_000 }, NOW)
  seedEvent(temp.store, session, { kind: 'tool_result', at: T0, tool: { name: 'Bash', output: 'kept' } })
  expect(applyRetention(temp.store.db, NOW).events).toBe(0)
  expect(readDataSettings(temp.store.db)).toEqual({ retention: { ...DEFAULT_RETENTION, events: null }, warnBytes: 1_000 })
})
