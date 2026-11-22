import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type EventKind, validateEvent } from '../contract/event'
import { ampMessageOutput, normalizeAmp } from './amp'

const DIR = join(import.meta.dir, '../../test/fixtures/amp')
const fixture = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(DIR, file), 'utf8'))
let counter = 0
const context = { now: () => 1_792_841_878_000, newId: () => `01JB${String(++counter).padStart(22, '0')}` }

test('every Amp fixture normalizes to the right kind with the thread as the session', () => {
  const expected: Record<string, EventKind> = {
    'docs-constructed-agent-end.json': 'turn_end',
    'docs-constructed-agent-start.json': 'user_prompt',
    'docs-constructed-session-start.json': 'session_start',
    'docs-constructed-tool-result-error.json': 'tool_result',
    'docs-constructed-tool-result.json': 'tool_result',
  }
  expect(readdirSync(DIR).sort()).toEqual(Object.keys(expected).sort())
  for (const [file, kind] of Object.entries(expected)) {
    const event = normalizeAmp(fixture(file), context)
    expect(event).toMatchObject({ kind, host: 'amp', hostSessionId: 'T-7f3a9c2e-1b4d-4e8a-9c3f-2a1b5d6e7f80', cwd: '/workspace/project' })
    expect(validateEvent(event).ok).toBe(true)
  }
  expect(normalizeAmp(fixture('docs-constructed-agent-start.json'), context)).toMatchObject({ promptText: 'Add a test for the parser', isUserTurn: true, hostPromptId: '0' })
  expect(normalizeAmp(fixture('docs-constructed-tool-result.json'), context)?.tool).toEqual({ name: 'Read', input: { path: '/workspace/project/src/parser.ts' }, output: 'export function parse() {}' })
  expect(normalizeAmp(fixture('docs-constructed-tool-result-error.json'), context)?.tool).toEqual({ name: 'Bash', input: { cmd: 'bun test' }, output: 'exit status 1', isError: true })
})

test('a cancelled tool call is not captured, and structured output is kept as JSON', () => {
  const done = fixture('docs-constructed-tool-result.json')
  expect(normalizeAmp({ ...done, status: 'cancelled' }, context)).toBeNull()
  expect(normalizeAmp({ ...done, output: { lines: 3 } }, context)?.tool?.output).toBe('{"lines":3}')
})

test('a minimal or garbage Amp payload gives null and never throws', () => {
  const start = fixture('docs-constructed-session-start.json')
  for (const payload of [null, 'x', [], {}, { event: 'agent.start' }, { ...start, thread: {} }, { ...start, cwd: 'relative' }, { ...start, event: 'tool.call' },
    { ...start, event: 'tool.result' }]) {
    expect(() => normalizeAmp(payload, context)).not.toThrow()
    expect(normalizeAmp(payload, context)).toBeNull()
  }
})

test('context goes back as the message agent.start returns, hidden from the user', () => {
  expect(ampMessageOutput('<kinfold>pack</kinfold>')).toBe(JSON.stringify({ message: { content: '<kinfold>pack</kinfold>', display: false } }))
})
