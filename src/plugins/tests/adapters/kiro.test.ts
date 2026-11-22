import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type EventKind, validateEvent } from '../contract/event'
import { KIRO_EVENTS, normalizeKiroWith } from './kiro'

const DIR = join(import.meta.dir, '../../test/fixtures/kiro')
const fixture = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(DIR, file), 'utf8'))
let counter = 0
const context = { now: () => 1_792_841_878_000, newId: () => `01JB${String(++counter).padStart(22, '0')}` }
const normalize = normalizeKiroWith(() => 'Add a test for the parser')

test('every Kiro fixture normalizes to the right kind, or null for a trigger install does not register', () => {
  const expected: Record<string, EventKind | null> = {
    'docs-agent-spawn.json': 'session_start',
    'docs-constructed-post-tool-use.json': 'tool_result',
    'docs-constructed-session-end.json': 'session_end',
    'docs-constructed-session-start.json': 'session_start',
    'docs-constructed-stop.json': 'turn_end',
    'docs-constructed-user-prompt-submit.json': 'user_prompt',
    'docs-pre-tool-use.json': null,
  }
  expect(readdirSync(DIR).sort()).toEqual(Object.keys(expected).sort())
  for (const [file, kind] of Object.entries(expected)) {
    const raw = fixture(file)
    const event = normalize(raw, context)
    if (kind === null) {
      expect(event).toBeNull()
      continue
    }
    expect(event).toMatchObject({ kind, host: 'kiro', hostSessionId: raw.session_id, cwd: raw.cwd })
    expect(validateEvent(event).ok).toBe(true)
  }
  expect(KIRO_EVENTS).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'])
})

test('the prompt comes from USER_PROMPT, since Kiro documents it there and not on stdin', () => {
  expect(normalize(fixture('docs-constructed-user-prompt-submit.json'), context)).toMatchObject({ promptText: 'Add a test for the parser', isUserTurn: true })
  expect(normalizeKiroWith(() => undefined)(fixture('docs-constructed-user-prompt-submit.json'), context)).toMatchObject({ promptText: '' })
  expect(normalize({ ...fixture('docs-constructed-user-prompt-submit.json'), prompt: 'from stdin' }, context)).toMatchObject({ promptText: 'from stdin' })
  expect(normalize(fixture('docs-constructed-post-tool-use.json'), context)?.tool).toMatchObject({ name: 'fs_read', input: { path: 'src/parser.ts' } })
})

test('a minimal or garbage Kiro payload gives null and never throws', () => {
  const start = fixture('docs-constructed-session-start.json')
  for (const payload of [null, 'x', [], {}, { hook_event_name: 'Stop' }, { ...start, session_id: '' }, { ...start, cwd: 'relative' },
    { hook_event_name: 'PostToolUse', cwd: '/w', session_id: 's' }]) {
    expect(() => normalize(payload, context)).not.toThrow()
    expect(normalize(payload, context)).toBeNull()
  }
})
