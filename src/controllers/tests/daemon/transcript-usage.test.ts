// Turn usage for the impact test: what one Claude Code turn cost, read from
// the agent's transcript at turn_end. Only usage numbers, block types and
// timestamps are read; a transcript that is missing, huge or malformed
// records nothing and never stops the daemon.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureEvent } from '../../../resources/capture/capture'
import { type NormalizedEvent, SCHEMA_VERSION } from '../../../system/contract/event'
import { ulid } from '../../../system/contract/ulid'
import { recordInjection } from '../../../resources/store/context-store'
import { type Store, openStore } from '../../../resources/store/db'
import { drainSpool } from '../../daemon/ingest'
import { MAX_TRANSCRIPT_TAIL_BYTES, MAX_TURN_END_AGE_MS, freshTurnEnds, readTurnUsage, recordTurnUsage } from '../../daemon/transcript-usage'

const HMAC = 'test-key'
let root: string
let spoolDir: string
let store: Store

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-turn-usage-'))
  spoolDir = join(root, 'spool')
  store = openStore(join(root, 'data'))
})
afterEach(() => {
  store.db.close()
  rmSync(root, { recursive: true, force: true })
})

const SECRET_TEXT = 'TRANSCRIPT-TEXT-THAT-IS-NEVER-KEPT'
const at = (seconds: number): string => new Date(Date.UTC(2026, 10, 15, 9, 0, seconds)).toISOString()
const usage = (input: number, output: number, read = 0, creation = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: creation })
const user = (text: string, seconds: number, extra: Record<string, unknown> = {}) => ({ type: 'user', isSidechain: false, timestamp: at(seconds), message: { role: 'user', content: text }, ...extra })
const toolResult = (seconds: number) => ({ type: 'user', isSidechain: false, timestamp: at(seconds), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: SECRET_TEXT }] } })
const assistant = (id: string, block: Record<string, unknown>, used: Record<string, number>, seconds: number, extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', isSidechain: false, timestamp: at(seconds), message: { id, role: 'assistant', content: [block], usage: used }, ...extra })
const text = { type: 'text', text: SECRET_TEXT }
const thinking = { type: 'thinking', thinking: SECRET_TEXT }
const tool = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: SECRET_TEXT } })

function transcript(name: string, entries: readonly (Record<string, unknown> | string)[]): string {
  const path = join(root, name)
  writeFileSync(path, `${entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n')}\n`)
  return path
}

/** An earlier turn, then the current one: two model calls, each logged once per content block. */
const TWO_TURNS = [
  { type: 'permission-mode', permissionMode: 'default' },
  user('first prompt', 0),
  assistant('msg_old', text, usage(900, 90, 9000, 90), 5),
  user('second prompt', 60),
  assistant('msg_a', thinking, usage(100, 40, 5000, 300), 62),
  assistant('msg_a', tool('toolu_1'), usage(100, 40, 5000, 300), 63),
  assistant('msg_a', tool('toolu_2'), usage(100, 40, 5000, 300), 63),
  toolResult(64),
  toolResult(64),
  { type: 'api-request-blob', message: { role: 'user', content: [{ type: 'text', text: SECRET_TEXT }] } },
  assistant('msg_b', text, usage(20, 60, 5400, 80), 70),
]

test('the current turn is the assistant entries after the last prompt, each model call counted once', () => {
  expect(readTurnUsage(transcript('t.jsonl', TWO_TURNS))).toEqual({
    inputTokens: 120, outputTokens: 100, cacheReadTokens: 10_400, cacheCreationTokens: 380, toolCalls: 2, durationMs: 10_000,
  })
})

test('a streamed call logged with growing output counts its largest figure, and a subagent is not this turn', () => {
  const path = transcript('t.jsonl', [
    user('prompt', 0),
    assistant('msg_a', thinking, usage(100, 1, 50, 0), 1),
    assistant('msg_a', text, usage(100, 37, 50, 0), 2),
    assistant('msg_side', text, usage(9999, 9999, 9999, 9999), 3, { isSidechain: true }),
    { ...user('a subagent prompt', 3), isSidechain: true },
  ])
  expect(readTurnUsage(path)).toEqual({ inputTokens: 100, outputTokens: 37, cacheReadTokens: 50, cacheCreationTokens: 0, toolCalls: 0, durationMs: 2_000 })
})

test('lines that are not JSON, entries of other shapes and missing numbers are skipped, not fatal', () => {
  const path = transcript('t.jsonl', [
    'not json at all',
    '{"type":"assistant"',
    user('prompt', 0),
    '',
    { type: 'assistant', isSidechain: false, message: 'a string, not an object' },
    { type: 'assistant', isSidechain: false, timestamp: 'not a date', message: { id: 'msg_x', content: 'text', usage: { input_tokens: 'many', output_tokens: -4, cache_read_input_tokens: 2.5 } } },
    assistant('msg_ok', tool('toolu_1'), usage(7, 8, 9, 10), 4),
    [1, 2, 3] as unknown as Record<string, unknown>,
  ])
  expect(readTurnUsage(path)).toEqual({ inputTokens: 7, outputTokens: 8, cacheReadTokens: 9, cacheCreationTokens: 10, toolCalls: 1, durationMs: 4_000 })
})

test('nothing is read from a path that is missing, not a .jsonl file, relative, a folder, or a turn with no model call', () => {
  expect(readTurnUsage(join(root, 'gone.jsonl'))).toBeNull()
  expect(readTurnUsage(transcript('notes.txt', TWO_TURNS))).toBeNull()
  expect(readTurnUsage('relative/t.jsonl')).toBeNull()
  mkdirSync(join(root, 'dir.jsonl'))
  expect(readTurnUsage(join(root, 'dir.jsonl'))).toBeNull()
  expect(readTurnUsage(transcript('empty.jsonl', []))).toBeNull()
  expect(readTurnUsage(transcript('prompt-only.jsonl', [user('prompt', 0)]))).toBeNull()
  expect(readTurnUsage(transcript('no-prompt.jsonl', [assistant('msg_a', text, usage(1, 1), 1)]))).toBeNull()
})

test('only the end of a huge transcript is read: a turn that fits there is counted, one that starts before it is not guessed', () => {
  expect(MAX_TRANSCRIPT_TAIL_BYTES).toBe(8 * 1024 * 1024)
  const padding = { type: 'api-request-blob', message: { role: 'user', content: 'x'.repeat(4096) } }
  const many = Array.from({ length: 30 }, () => padding)
  const fits = transcript('fits.jsonl', [user('old', 0), assistant('msg_old', text, usage(5, 5), 1), ...many, user('prompt', 60), assistant('msg_a', text, usage(3, 4), 61)])
  expect(readTurnUsage(fits, 64 * 1024)).toEqual({ inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0, toolCalls: 0, durationMs: 1_000 })
  // The prompt is outside the tail: the assistant entries seen could be half a turn, so none is reported.
  const cut = transcript('cut.jsonl', [user('prompt', 0), assistant('msg_a', text, usage(3, 4), 1), ...many, assistant('msg_b', text, usage(3, 4), 2)])
  expect(readTurnUsage(cut, 64 * 1024)).toBeNull()
})

test('a long turn is read across several widening steps: every call counted once, many-byte text cut by a step kept whole, and nothing before the prompt parsed', () => {
  // About 1.5 MB after the prompt, in lines of odd lengths full of 3-byte characters, so the 256 KB and 1 MB steps cut lines and characters.
  const noise = (index: number) => ({ type: 'api-request-blob', message: { role: 'user', content: '漢字'.repeat(700 + (index % 13)) } })
  const turn: Record<string, unknown>[] = []
  for (let index = 0; index < 300; index += 1) {
    turn.push(noise(index))
    if (index % 30 === 0) turn.push(assistant(`msg_${index / 30}`, tool(`toolu_${index}`), usage(10, 1, 100, 0), 61 + index / 30))
  }
  const before = Array.from({ length: 200 }, (_, index) => noise(index))
  const path = transcript('long.jsonl', [user('old', 0), assistant('msg_old', text, usage(999, 999), 1), ...before, user('prompt', 60), ...turn])
  const realParse = JSON.parse
  let parsed = 0
  JSON.parse = ((value: string) => {
    parsed += 1
    return realParse(value)
  }) as typeof JSON.parse
  try {
    expect(readTurnUsage(path)).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 1_000, cacheCreationTokens: 0, toolCalls: 10, durationMs: 10_000 })
  } finally {
    JSON.parse = realParse
  }
  // The turn's own lines and its prompt, once each: not the 202 lines before it, and not the tail again at each step.
  expect(parsed).toBe(turn.length + 1)
})

// --- through ingest ---

let clock = 1_792_841_878_000
function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  clock += 1_000
  return { schemaVersion: SCHEMA_VERSION, eventId: ulid(clock), host: 'claude-code', hostSessionId: 'session-1', kind: 'session_start', occurredAt: clock, cwd: '/work/repo', ...overrides }
}
const drain = () => {
  const result = drainSpool(store.db, { spoolDir, hmacKey: HMAC, projectKeyFor: () => ({ key: 'org/repo', kind: 'git-remote', displayName: 'repo' }) })
  expect(result.error).toBeUndefined()
  return result
}
const spool = (...events: NormalizedEvent[]): void => {
  for (const item of events) captureEvent(item, { spoolDir, hmacKey: HMAC })
}
const usageRows = () => store.db.query(
  `SELECT session_id AS sessionId, prompt_number AS promptNumber, host, project_key AS projectKey, held_out AS heldOut, input_tokens AS inputTokens,
     output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens, tool_calls AS toolCalls, duration_ms AS durationMs
   FROM turn_usage ORDER BY session_id, prompt_number`,
).all()

test('a drain hands back each new Claude Code turn_end that names a transcript, and recording it writes one row per turn', () => {
  const path = transcript('t.jsonl', TWO_TURNS)
  // Events sort by their id, which carries their time: built in the order they happened.
  const before = [event(), event({ kind: 'user_prompt', promptText: 'p' })]
  const end = event({ kind: 'turn_end', transcriptPath: path })
  spool(...before, end)
  const drained = drain()
  expect(drained.turnEnds).toEqual([{ sessionId: 1, promptNumber: 1, host: 'claude-code', projectKey: 'org/repo', transcriptPath: path, occurredAt: end.occurredAt }])
  const logs: string[] = []
  expect(recordTurnUsage(store.db, drained.turnEnds, (line) => logs.push(line))).toBe(1)
  expect(usageRows()).toEqual([{
    sessionId: 1, promptNumber: 1, host: 'claude-code', projectKey: 'org/repo', heldOut: 0,
    inputTokens: 120, outputTokens: 100, cacheReadTokens: 10_400, cacheCreationTokens: 380, toolCalls: 2, durationMs: 10_000,
  }])
  // Numbers and ids only: neither the path nor anything from the transcript is logged or stored.
  expect(logs.join('\n')).not.toContain(root)
  expect(JSON.stringify(usageRows())).not.toContain(SECRET_TEXT)

  // Stop again for the same prompt, after more work: the row is replaced, not doubled.
  writeFileSync(path, `${[...TWO_TURNS, assistant('msg_c', text, usage(1, 1, 1, 1), 80)].map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  spool(event({ kind: 'turn_end', transcriptPath: path }))
  expect(recordTurnUsage(store.db, drain().turnEnds, () => {})).toBe(1)
  expect(usageRows()).toHaveLength(1)
  expect(usageRows()[0]).toMatchObject({ inputTokens: 121, outputTokens: 101, durationMs: 20_000 })
})

test('a held-out prompt is marked on its turn, from the injection the holdout left', () => {
  const path = transcript('t.jsonl', TWO_TURNS)
  spool(event(), event({ kind: 'user_prompt', promptText: 'p' }), event({ kind: 'turn_end', transcriptPath: path }),
    event({ kind: 'user_prompt', promptText: 'q' }), event({ kind: 'turn_end', transcriptPath: path }))
  const drained = drain()
  recordInjection(store.db, { sessionId: 1, host: 'claude-code', hostSessionId: 'session-1', projectKey: 'org/repo', observationIds: [], channel: 'prompt', tokens: 0, occurredAt: clock, promptNumber: 2, heldOut: true })
  expect(recordTurnUsage(store.db, drained.turnEnds, () => {})).toBe(2)
  expect((usageRows() as { promptNumber: number; heldOut: number }[]).map((row) => [row.promptNumber, row.heldOut])).toEqual([[1, 0], [2, 1]])
})

test('other agents, a turn_end with no transcript or no prompt, a duplicate and an unreadable transcript record nothing', () => {
  const path = transcript('t.jsonl', TWO_TURNS)
  const before = [
    event({ host: 'codex', hostSessionId: 'cx' }), event({ host: 'codex', hostSessionId: 'cx', kind: 'user_prompt', promptText: 'p' }),
    event({ host: 'codex', hostSessionId: 'cx', kind: 'turn_end', transcriptPath: path }),
    event({ hostSessionId: 'no-prompt' }), event({ hostSessionId: 'no-prompt', kind: 'turn_end', transcriptPath: path }),
    event(), event({ kind: 'user_prompt', promptText: 'p' }), event({ kind: 'turn_end' }),
  ]
  const end = event({ kind: 'turn_end', transcriptPath: path })
  spool(...before, end)
  const first = drain()
  expect(first.turnEnds.map((turn) => [turn.host, turn.promptNumber])).toEqual([['claude-code', 1]])
  spool(end)
  expect(drain().turnEnds).toEqual([])

  const logs: string[] = []
  expect(recordTurnUsage(store.db, [{ ...first.turnEnds[0]!, transcriptPath: join(root, 'gone.jsonl') }], (line) => logs.push(line))).toBe(0)
  expect(usageRows()).toEqual([])
  expect(logs).toEqual(['turn usage session=3 prompt=1 not read'])
})

test('a path that is not a regular file is refused before it is opened: a FIFO would hang the daemon', () => {
  const fifo = join(root, 'pipe.jsonl')
  expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
  const startedAt = Date.now()
  expect(readTurnUsage(fifo)).toBeNull()
  expect(Date.now() - startedAt).toBeLessThan(1000)
  const real = transcript('real.jsonl', TWO_TURNS)
  const link = join(root, 'link.jsonl')
  symlinkSync(real, link)
  expect(readTurnUsage(link)).toBeNull()
})

test('after a backlog only the newest turn_end of a session is read, and only while it is fresh: an older one would get the latest turn\'s numbers', () => {
  const path = transcript('t.jsonl', TWO_TURNS)
  spool(event(), event({ kind: 'user_prompt', promptText: 'p' }), event({ kind: 'turn_end', transcriptPath: path }),
    event({ kind: 'user_prompt', promptText: 'q' }), event({ kind: 'turn_end', transcriptPath: path }))
  const drained = drain()
  expect(drained.turnEnds.map((turn) => turn.promptNumber)).toEqual([1, 2])
  const newest = drained.turnEnds[1]!.occurredAt
  expect(freshTurnEnds(drained.turnEnds, newest + 1_000).map((turn) => turn.promptNumber)).toEqual([2])
  // Read long after the turn ended, the transcript may have moved on.
  expect(freshTurnEnds(drained.turnEnds, newest + MAX_TURN_END_AGE_MS + 1)).toEqual([])
})

test('read for the debug trace only, a turn is handed over and no turn_usage row is stored', () => {
  const path = transcript('t.jsonl', TWO_TURNS)
  spool(event(), event({ kind: 'user_prompt', promptText: 'p' }), event({ kind: 'turn_end', transcriptPath: path }))
  const read: [number, number | null][] = []
  expect(recordTurnUsage(store.db, drain().turnEnds, () => {}, { store: false, onRead: (turn, used) => read.push([turn.promptNumber, used?.outputTokens ?? null]) })).toBe(0)
  expect(usageRows()).toEqual([])
  expect(read).toEqual([[1, 100]])
})

test('a failing trace callback costs the trace only: the impact-test rows are still stored', () => {
  const path = transcript('t.jsonl', TWO_TURNS)
  spool(event(), event({ kind: 'user_prompt', promptText: 'p' }), event({ kind: 'turn_end', transcriptPath: path }))
  const logs: string[] = []
  expect(recordTurnUsage(store.db, drain().turnEnds, (line) => logs.push(line), { onRead: () => { throw new TypeError('boom') } })).toBe(1)
  expect(logs).toContain('turn usage trace failed: TypeError')
})
