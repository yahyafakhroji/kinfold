import { afterEach, beforeEach, expect, test } from 'bun:test'
import { seedObservation } from '../context/test-support'
import { type TempStore, T0, openTempStore, seedEvent, seedSession } from '../observer/test-support'
import { markerRefs } from '../redaction/redact'
import { listFindings } from '../store/findings-store'
import { resolveFinding } from './resolve'
import { scanBatch, scanUntil } from './scanner'
import { FRAGMENT, HMAC_KEY, markV1 } from './test-support'

const OLD = '<redacted type="openrouter_key" ref="0a1b2c3d"/>'
const NEW = '<redacted type="github_token" ref="e202610.9f8e7d6c"/>'
const EPOCH = 202611

let temp: TempStore
let session: number
beforeEach(() => {
  temp = openTempStore('sam-scan-epochs-')
  session = seedSession(temp.store, 'claude-code', 'cc-1')
})
afterEach(() => temp.cleanup())

const options = { hmacKey: HMAC_KEY, epoch: EPOCH, now: () => T0 + 1_000 }
const payloadOf = (eventId: string): string =>
  String((temp.store.db.query(`SELECT payload FROM events WHERE event_id = '${eventId}'`).get() as { payload: string }).payload)

test('rows holding untagged and epoch-tagged markers, side by side, are not findings', () => {
  seedEvent(temp.store, session, { kind: 'tool_result', at: T0, tool: { name: 'Bash', output: `old ${OLD} new ${NEW} done` } })
  seedObservation(temp.store, { sessionId: session, projectKey: 'org/repo', host: 'claude-code', title: `Used ${NEW} and ${OLD}`, at: T0 })
  markV1(temp, 'events')
  expect(scanUntil(temp.store.db, options, 5_000)).toMatchObject({ scanned: 2, findings: 0 })
})

test('resolve redact keeps both old and new markers and tags only the new hit with the current epoch', () => {
  const eventId = seedEvent(temp.store, session, { kind: 'tool_result', at: T0, tool: { name: 'Bash', output: `old ${OLD} new ${NEW} leak ${FRAGMENT}` } })
  markV1(temp, 'events')
  scanBatch(temp.store.db, options)
  const [finding] = listFindings(temp.store.db, { action: 'pending', limit: 1 })
  expect(finding?.rule).toBe('key_fragment')
  expect(resolveFinding(temp.store.db, finding!.id, 'redact', options)).toMatchObject({ ok: true })
  const output = String(JSON.parse(payloadOf(eventId)).tool.output)
  expect(output).toContain(OLD)
  expect(output).toContain(NEW)
  expect(output).not.toContain(FRAGMENT)
  expect(markerRefs(output).map((ref) => ref.epoch)).toEqual([0, 202610, EPOCH])
})

test('a resolved row scanned again under a later epoch is not redacted again', () => {
  const eventId = seedEvent(temp.store, session, { kind: 'tool_result', at: T0, tool: { name: 'Bash', output: `old ${OLD} leak ${FRAGMENT}` } })
  markV1(temp, 'events')
  scanBatch(temp.store.db, options)
  const [finding] = listFindings(temp.store.db, { action: 'pending', limit: 1 })
  resolveFinding(temp.store.db, finding!.id, 'redact', options)
  const once = payloadOf(eventId)
  markV1(temp, 'events')
  expect(scanBatch(temp.store.db, { ...options, epoch: 202612 })).toMatchObject({ scanned: 1, findings: 0 })
  expect(payloadOf(eventId)).toBe(once)
})
