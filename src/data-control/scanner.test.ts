import { afterEach, beforeEach, expect, test } from 'bun:test'
import { seedObservation } from '../context/test-support'
import { type TempStore, T0, openTempStore, seedEvent, seedSession } from '../observer/test-support'
import { RULES_VERSION } from '../redaction/rules'
import { listFindings } from '../store/findings-store'
import { insertPrompt } from '../store/writes'
import { resolveFinding } from './resolve'
import { describeScan, scanBatch, scanUntil } from './scanner'
import { FRAGMENT, HMAC_KEY, ftsMatch, markV1 } from './test-support'

let temp: TempStore
let session: number
beforeEach(() => {
  temp = openTempStore('sam-scan-')
  session = seedSession(temp.store, 'claude-code', 'cc-1')
})
afterEach(() => temp.cleanup())

const options = { hmacKey: HMAC_KEY, now: () => T0 + 1_000 }
const all = (sql: string) => temp.store.db.query(sql).all() as Record<string, unknown>[]
const versions = (table: string) => all(`SELECT DISTINCT scanned_version AS v FROM ${table}`).map((row) => row.v)

/** An event stored before rules v2 kept the fragment: v1 had no key_fragment rule. */
function seedV1Leak(): string {
  const id = seedEvent(temp.store, session, { kind: 'tool_result', at: T0, promptNumber: 1, tool: { name: 'Bash', output: `the key starts ${FRAGMENT} in the log`, exitCode: 0 } })
  seedEvent(temp.store, session, { kind: 'tool_result', at: T0 + 1, promptNumber: 1, tool: { name: 'Bash', output: '12 pass, nothing secret', exitCode: 0 } })
  markV1(temp, 'events')
  return id
}

test('the scanner finds a fragment a v1 row kept, without storing, logging or returning the value', () => {
  const eventId = seedV1Leak()
  const result = scanUntil(temp.store.db, options, 5_000)
  expect(result).toMatchObject({ scanned: 2, findings: 1, byRule: { key_fragment: 1 }, remaining: 0 })
  const findings = listFindings(temp.store.db, { action: 'pending', limit: 10 })
  expect(findings).toEqual([expect.objectContaining({ table: 'events', rowId: eventId, field: 'tool.output', rule: 'key_fragment', ruleVersion: RULES_VERSION, matches: 1, action: 'pending' })])
  const stored = JSON.stringify(all('SELECT * FROM redaction_findings'))
  for (const text of [stored, JSON.stringify(result), describeScan(result)]) {
    expect(text).not.toContain(FRAGMENT)
    expect(text).not.toContain('Qz7Wx')
  }
  // Scanning does not rewrite the row.
  expect(String(all(`SELECT payload FROM events WHERE event_id = '${eventId}'`)[0]!.payload)).toContain(FRAGMENT)
  expect(versions('events')).toEqual([RULES_VERSION])
})

test('a second run finds nothing new, and rows written under the current rules are not re-checked', () => {
  seedV1Leak()
  scanUntil(temp.store.db, options, 5_000)
  expect(scanBatch(temp.store.db, options)).toMatchObject({ scanned: 0, findings: 0, remaining: 0 })
  seedEvent(temp.store, session, { kind: 'tool_result', at: T0 + 2, tool: { name: 'Bash', output: FRAGMENT } })
  expect(scanBatch(temp.store.db, options)).toMatchObject({ scanned: 0, findings: 0 })
  expect(listFindings(temp.store.db, { action: null, limit: 10 })).toHaveLength(1)
})

test('observer output is checked once on its own, since no rule ran over it on write', () => {
  const id = seedObservation(temp.store, { sessionId: session, projectKey: 'org/repo', host: 'claude-code', title: `Key ${FRAGMENT} found in summary file`, at: T0 })
  insertPrompt(temp.store.db, { sessionId: session, promptNumber: 1, text: 'a clean prompt', occurredAt: T0 })
  const result = scanBatch(temp.store.db, options)
  expect(result).toMatchObject({ scanned: 1, findings: 1, byRule: { key_fragment: 1 } })
  expect(listFindings(temp.store.db, { action: 'pending', limit: 10 })).toEqual([expect.objectContaining({ table: 'observations', rowId: String(id), field: 'title' })])
})

test('an intact withheld marker and existing redaction markers are not findings', () => {
  seedEvent(temp.store, session, { kind: 'tool_result', at: T0, tool: { name: 'Bash', input: { command: 'cat .env' }, output: '<withheld reason="sensitive_command" lines="3" chars="90"/>', withheld: 'sensitive_command' } })
  seedEvent(temp.store, session, { kind: 'tool_result', at: T0 + 1, tool: { name: 'Bash', output: 'token <redacted type="openrouter_key" ref="0a1b2c3d"/> used' } })
  markV1(temp, 'events')
  expect(scanBatch(temp.store.db, options)).toMatchObject({ scanned: 2, findings: 0 })
})

test('batches stay small: a batch of 1 leaves the rest for later ticks', () => {
  seedV1Leak()
  expect(scanBatch(temp.store.db, { ...options, batchSize: 1 })).toMatchObject({ scanned: 1, remaining: 1 })
  expect(scanBatch(temp.store.db, { ...options, batchSize: 1 })).toMatchObject({ scanned: 1, remaining: 0 })
})

test('resolve redact rewrites the field in place with the current rules and settles the finding', () => {
  const eventId = seedV1Leak()
  scanUntil(temp.store.db, options, 5_000)
  const [finding] = listFindings(temp.store.db, { action: 'pending', limit: 1 })
  const outcome = resolveFinding(temp.store.db, finding!.id, 'redact', options)
  expect(outcome).toMatchObject({ ok: true, finding: { action: 'redacted', resolvedAt: T0 + 1_000 }, purge: null })
  const row = all(`SELECT payload, redactions, rules_version AS r, scanned_version AS s FROM events WHERE event_id = '${eventId}'`)[0]!
  expect(String(row.payload)).not.toContain(FRAGMENT)
  expect(String(row.payload)).toContain('<redacted type=\\"key_fragment\\"')
  expect(JSON.parse(String(row.redactions))).toContainEqual({ field: 'tool.output', rule: 'key_fragment', count: 1 })
  expect([row.r, row.s]).toEqual([RULES_VERSION, RULES_VERSION])
  expect(resolveFinding(temp.store.db, finding!.id, 'redact', options)).toEqual({ ok: false, status: 409, error: 'finding is already redacted' })
  expect(resolveFinding(temp.store.db, 9_999, 'purge', options)).toEqual({ ok: false, status: 404, error: 'no such finding' })
})

test('resolve redact on an observation updates FTS; resolve purge deletes the row through the purge path', () => {
  const kept = seedObservation(temp.store, { sessionId: session, projectKey: 'org/repo', host: 'claude-code', title: `Leaky ${FRAGMENT} qxredactword`, at: T0 })
  const purged = seedObservation(temp.store, { sessionId: session, projectKey: 'org/repo', host: 'claude-code', title: `Also ${FRAGMENT} qxpurgeword`, at: T0 + 1 })
  scanBatch(temp.store.db, options)
  const byRow = new Map(listFindings(temp.store.db, { action: 'pending', limit: 10 }).map((finding) => [finding.rowId, finding.id]))
  expect(resolveFinding(temp.store.db, byRow.get(String(kept))!, 'redact', options).ok).toBe(true)
  expect(ftsMatch(temp, 'qxredactword')).toEqual([kept])
  expect(String(all(`SELECT title FROM observations WHERE id = ${kept}`)[0]!.title)).not.toContain(FRAGMENT)

  const outcome = resolveFinding(temp.store.db, byRow.get(String(purged))!, 'purge', options)
  expect(outcome).toMatchObject({ ok: true, finding: { action: 'purged' }, purge: { counts: { observations: 1, findings: 1 } } })
  expect(ftsMatch(temp, 'qxpurgeword')).toEqual([])
  expect(all(`SELECT id FROM observations WHERE id = ${purged}`)).toEqual([])
})
