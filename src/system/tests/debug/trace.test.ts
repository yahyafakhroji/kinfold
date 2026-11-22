import { expect, test } from 'bun:test'
import { TRACE_MAX_EVENTS, WATCHING_MS, type TraceInput, createTraceBuffer } from '../../debug/trace'

const start = (n: number, fields: Partial<TraceInput> = {}): TraceInput =>
  ({ kind: 'start', at: n, host: 'claude-code', project: 'kinfold', projectKey: 'key-kinfold', hostSessionId: `s${n}`, rows: [], tokens: n, ...fields }) as TraceInput

test('events get a rising cursor and are read after it', () => {
  const trace = createTraceBuffer()
  expect(trace.read({ after: null, host: null, project: null })).toMatchObject({ cursor: 0, events: [] })
  trace.push(start(1))
  trace.push(start(2))
  const all = trace.read({ after: 0, host: null, project: null })
  expect(all.cursor).toBe(2)
  expect(all.events.map((event) => event.seq)).toEqual([1, 2])
  expect(trace.read({ after: 1, host: null, project: null }).events.map((event) => event.seq)).toEqual([2])
  // Without a cursor a watcher starts from now.
  expect(trace.read({ after: null, host: null, project: null })).toMatchObject({ cursor: 2, events: [] })
})

test('host and project filters apply; the project matches its key or its name in any case', () => {
  const trace = createTraceBuffer()
  trace.push(start(1))
  trace.push(start(2, { host: 'opencode' }))
  trace.push(start(3, { project: 'other', projectKey: 'key-other' }))
  const seqs = (host: string | null, project: string | null): number[] => trace.read({ after: 0, host, project }).events.map((event) => event.seq)
  expect(seqs('opencode', null)).toEqual([2])
  expect(seqs(null, 'KINFOLD')).toEqual([1, 2])
  expect(seqs(null, 'key-other')).toEqual([3])
  // The cursor passes filtered-out events too, so a watcher never asks for them again.
  expect(trace.read({ after: 0, host: 'opencode', project: null }).cursor).toBe(3)
})

test('the buffer keeps the newest events, bounded by count and by bytes', () => {
  const trace = createTraceBuffer()
  for (let n = 1; n <= TRACE_MAX_EVENTS + 10; n++) trace.push(start(n))
  const kept = trace.read({ after: 0, host: null, project: null }).events
  expect(kept).toHaveLength(TRACE_MAX_EVENTS)
  expect(kept[0]!.seq).toBe(11)

  const small = createTraceBuffer({ maxEvents: 100, maxBytes: 2_000 })
  for (let n = 1; n <= 50; n++) small.push(start(n, { rows: [{ id: n, title: 'x'.repeat(100) }] }))
  const bytes = small.read({ after: 0, host: null, project: null }).events.reduce((sum, event) => sum + JSON.stringify(event).length, 0)
  expect(bytes).toBeLessThanOrEqual(2_000)
  expect(small.read({ after: 0, host: null, project: null }).events.at(-1)!.seq).toBe(50)
})

test('a watcher counts as connected for a short while after its last read', () => {
  const trace = createTraceBuffer()
  expect(trace.watching(1_000)).toBe(false)
  trace.read({ after: null, host: null, project: null }, 1_000)
  expect(trace.watching(1_000 + WATCHING_MS)).toBe(true)
  expect(trace.watching(1_000 + WATCHING_MS + 1)).toBe(false)
})

test('each buffer has its own epoch, so a watcher can tell a restarted daemon', () => {
  const one = createTraceBuffer().read({ after: null, host: null, project: null })
  const two = createTraceBuffer().read({ after: null, host: null, project: null })
  expect(one.epoch).toMatch(/^[0-9a-f]{16}$/)
  expect(one.epoch).not.toBe(two.epoch)
})
