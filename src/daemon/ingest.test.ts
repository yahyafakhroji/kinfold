import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_SECRETS } from '../../test/fixtures/secrets'
import { captureEvent } from '../capture/capture'
import { type NormalizedEvent, SCHEMA_VERSION } from '../contract/event'
import { ulid } from '../contract/ulid'
import { QUARANTINE_DIR } from '../spool/spool'
import { type Store, openStore } from '../store/db'
import { contentHash, drainSpool, secondPass } from './ingest'

const HMAC = 'test-key'
let root: string
let spoolDir: string
let store: Store

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-ingest-'))
  spoolDir = join(root, 'spool')
  store = openStore(join(root, 'data'))
})
afterEach(() => {
  store.db.close()
  rmSync(root, { recursive: true, force: true })
})

let clock = 1_792_841_878_000
function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  clock += 1
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: ulid(clock),
    host: 'claude-code',
    hostSessionId: 'session-1',
    kind: 'session_start',
    occurredAt: clock,
    cwd: '/work/repo',
    ...overrides,
  }
}

function spool(...events: NormalizedEvent[]): string[] {
  return events.map((item) => captureEvent(item, { spoolDir, hmacKey: HMAC }))
}

const drain = (batchSize?: number) =>
  drainSpool(store.db, {
    spoolDir,
    hmacKey: HMAC,
    projectKeyFor: () => ({ key: 'org/repo', kind: 'git-remote', displayName: 'repo' }),
    ...(batchSize !== undefined ? { batchSize } : {}),
  })

const rows = <T>(sql: string): T[] => store.db.query<T, []>(sql).all()

test('the same host_session_id under two hosts makes two sessions', () => {
  spool(event({ host: 'claude-code' }), event({ host: 'opencode' }), event({ host: 'opencode', kind: 'session_end' }))
  const result = drain()

  expect(result).toMatchObject({ read: 3, inserted: 3, removed: 3, quarantined: [] })
  const sessions = rows<{ host: string; ended_at: number | null }>('SELECT host, ended_at FROM sessions ORDER BY host')
  expect(sessions.map((row) => row.host)).toEqual(['claude-code', 'opencode'])
  expect(sessions[0]!.ended_at).toBeNull()
  expect(sessions[1]!.ended_at).toBeGreaterThan(0)
})

test('user turns take the next prompt number; a non-user turn and tool events do not', () => {
  spool(
    event({ kind: 'user_prompt', promptText: 'first', isUserTurn: true, hostPromptId: 'p1' }),
    event({ kind: 'user_prompt', promptText: 'second', isUserTurn: true, hostPromptId: 'p2' }),
    event({ kind: 'user_prompt', promptText: 'tool round', isUserTurn: false }),
    event({ kind: 'tool_result', hostPromptId: 'p1', tool: { name: 'Read', input: {}, output: 'late result for p1' } }),
    event({ kind: 'turn_end', assistantText: 'done' }),
  )
  drain()

  expect(rows('SELECT prompt_number, host_prompt_id, text FROM prompts ORDER BY prompt_number')).toEqual([
    { prompt_number: 1, host_prompt_id: 'p1', text: 'first' },
    { prompt_number: 2, host_prompt_id: 'p2', text: 'second' },
  ])
  const numbers = rows<{ prompt_number: number | null }>('SELECT prompt_number FROM events ORDER BY occurred_at')
  expect(numbers.map((row) => row.prompt_number)).toEqual([1, 2, 2, 1, 2])
})

test('an event before any prompt has no prompt number', () => {
  spool(event({ kind: 'session_start' }))
  drain()
  expect(rows('SELECT prompt_number FROM events')).toEqual([{ prompt_number: null }])
})

test('a retried event_id is ignored and never takes a second prompt number', () => {
  const prompt = event({ kind: 'user_prompt', promptText: 'once', isUserTurn: true })
  spool(prompt)
  drain()
  spool(prompt)
  const retry = drain()

  expect(retry).toMatchObject({ read: 1, inserted: 0, duplicates: 1, removed: 1 })
  expect(rows('SELECT count(*) AS n FROM events')).toEqual([{ n: 1 }])
  expect(rows('SELECT count(*) AS n FROM prompts')).toEqual([{ n: 1 }])
})

test('a failing insert rolls back the batch and leaves its spool files in place', () => {
  const paths = spool(event(), event({ kind: 'turn_end' }))
  store.db.run("CREATE TRIGGER fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk said no'); END")

  const failed = drain()
  expect(failed.error).toContain('disk said no')
  expect(failed.removed).toBe(0)
  for (const path of paths) expect(existsSync(path)).toBe(true)
  expect(rows('SELECT count(*) AS n FROM sessions')).toEqual([{ n: 0 }])

  store.db.run('DROP TRIGGER fail_events')
  expect(drain()).toMatchObject({ inserted: 2, removed: 2 })
  for (const path of paths) expect(existsSync(path)).toBe(false)
})

test('quarantined spool entries are reported and nothing from them is stored', () => {
  spool(event())
  writeFileSync(join(spoolDir, `${'1'.padStart(13, '0')}-${ulid(1)}.json`), '{not json')
  const result = drain()

  expect(result.inserted).toBe(1)
  expect(result.quarantined).toHaveLength(1)
  expect(result.quarantined[0]!.path).toContain(QUARANTINE_DIR)
  expect(result.quarantined[0]!.reason).toStartWith('unreadable JSON')
  expect(rows('SELECT count(*) AS n FROM events')).toEqual([{ n: 1 }])
})

test('several batches drain in order until the spool is empty', () => {
  spool(event(), event(), event(), event(), event())
  expect(drain(2)).toMatchObject({ read: 5, inserted: 5, removed: 5 })
  expect(readdirSync(spoolDir).filter((name) => name.endsWith('.json'))).toEqual([])
})

test('stored rows keep redaction, the withheld marker and a content hash', () => {
  const leaky = event({ kind: 'tool_result', tool: { name: 'Bash', input: { command: 'echo' }, output: `key ${FAKE_SECRETS.github}` } })
  const env = event({ kind: 'tool_result', tool: { name: 'Read', input: { file_path: '/work/repo/.env' }, output: 'A=1\nB=2' } })
  spool(leaky, env)
  drain()

  const stored = rows<{ payload: string; withheld: string | null; redactions: string; content_hash: string; observer_state: string }>(
    'SELECT payload, withheld, redactions, content_hash, observer_state FROM events ORDER BY occurred_at',
  )
  expect(stored[0]!.payload).not.toContain(FAKE_SECRETS.github)
  expect(JSON.parse(stored[0]!.redactions)).toEqual([{ field: 'tool.output', rule: 'github_token', count: 1 }])
  expect(stored[1]!.withheld).toBe('sensitive_path')
  expect(JSON.parse(stored[1]!.payload).tool.output).toBe('<withheld reason="sensitive_path" lines="2" chars="7"/>')
  expect(stored[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/)
  expect(stored.map((row) => row.observer_state)).toEqual(['pending', 'pending'])
})

function edgeCopy(raw: NormalizedEvent): NormalizedEvent {
  return JSON.parse(readFileSync(spool(raw)[0]!, 'utf8')) as NormalizedEvent
}

test('the second pass leaves a redacted, size-capped event unchanged', () => {
  const output = `${FAKE_SECRETS.github}\n${'x'.repeat(20_000)}`
  const edge = edgeCopy(event({ kind: 'tool_result', tool: { name: 'Bash', input: { command: 'ls' }, output } }))
  const again = secondPass(edge, { hmacKey: HMAC })

  expect(edge.tool!.output).toContain('<truncated')
  expect(again.tool).toEqual(edge.tool!)
  expect(again.redactions).toEqual(edge.redactions!)
  expect(contentHash(again)).toBe(contentHash(edge))
})

test('the second pass keeps the original withheld marker instead of describing the marker', () => {
  const edge = edgeCopy(event({ kind: 'tool_result', tool: { name: 'Bash', input: { command: 'printenv' }, output: 'A=1\nB=2\nC=3' } }))
  const again = secondPass(edge, { hmacKey: HMAC })

  expect(again.tool!.output).toBe('<withheld reason="sensitive_command" lines="3" chars="11"/>')
  expect(again.tool!.withheld).toBe('sensitive_command')
  expect(again.redactions).toEqual(edge.redactions!)
})
