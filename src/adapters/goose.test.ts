import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type EventKind, validateEvent } from '../contract/event'
import { GOOSE_EVENTS, normalizeGoose } from './goose'

const DIR = join(import.meta.dir, '../../test/fixtures/goose')
const fixture = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(DIR, file), 'utf8'))
let counter = 0
const context = { now: () => 1_792_841_878_000, newId: () => `01JB${String(++counter).padStart(22, '0')}` }

test('goose: each fixture normalizes to the right kind with session, cwd and tool fields', () => {
  // Goose documents working_dir on tool events only; the rest carry no folder and are not captured.
  const expected: Record<string, EventKind | null> = {
    'docs-constructed-post-tool-use-failure.json': 'tool_result',
    'docs-constructed-post-tool-use.json': 'tool_result',
    'docs-constructed-session-end.json': null,
    'docs-constructed-session-start.json': null,
    'docs-constructed-stop.json': null,
    'docs-constructed-user-prompt-submit.json': null,
  }
  expect(readdirSync(DIR).sort()).toEqual(Object.keys(expected).sort())
  for (const [file, kind] of Object.entries(expected)) {
    const event = normalizeGoose(fixture(file), context)
    if (kind === null) {
      expect(event).toBeNull()
      continue
    }
    expect(event).toMatchObject({ kind, host: 'goose', hostSessionId: '20260514_1', cwd: '/Users/you/project' })
    expect(validateEvent(event).ok).toBe(true)
  }
  expect(normalizeGoose(fixture('docs-constructed-post-tool-use.json'), context)?.tool).toEqual({ name: 'shell', input: { command: 'ls' }, output: '' })
  expect(normalizeGoose(fixture('docs-constructed-post-tool-use-failure.json'), context)?.tool).toMatchObject({ name: 'shell', input: { command: 'false' }, isError: true })
  // Only the events documented with a working folder are registered; the rest would run the hook and record nothing.
  expect(GOOSE_EVENTS).toEqual(['PostToolUse', 'PostToolUseFailure'])
})

test('goose: events that do carry a working folder are captured, with the prompt, reply and tool output read when present', () => {
  const at = { working_dir: '/Users/you/project' }
  expect(normalizeGoose({ ...fixture('docs-constructed-session-start.json'), ...at }, context)).toMatchObject({ kind: 'session_start', cwd: '/Users/you/project' })
  expect(normalizeGoose({ ...fixture('docs-constructed-user-prompt-submit.json'), ...at }, context)).toMatchObject({ kind: 'user_prompt', promptText: 'summarize this file', isUserTurn: true })
  expect(normalizeGoose({ ...fixture('docs-constructed-stop.json'), ...at }, context)).toMatchObject({ kind: 'turn_end', assistantText: 'Done. I updated the file and ran the tests.' })
  expect(normalizeGoose({ ...fixture('docs-constructed-post-tool-use.json'), tool_output: 'a.txt' }, context)?.tool?.output).toBe('a.txt')
  expect(normalizeGoose({ ...fixture('docs-constructed-post-tool-use-failure.json'), tool_output: 'boom' }, context)?.tool).toMatchObject({ output: 'boom', isError: true })
})

test('goose: a minimal or garbage payload gives null and never throws', () => {
  const tool = fixture('docs-constructed-post-tool-use.json')
  for (const payload of [null, 'x', [], {}, { event: 'PostToolUse' }, { ...tool, session_id: '' }, { ...tool, working_dir: 'relative' }, { ...tool, tool_name: undefined }]) {
    expect(() => normalizeGoose(payload, context)).not.toThrow()
    expect(normalizeGoose(payload, context)).toBeNull()
  }
})
