import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type EventKind, validateEvent } from '../contract/event'
import { KIMI_CODE_EVENTS, normalizeKimiCode } from './kimi-code'

const DIR = join(import.meta.dir, '../../test/fixtures/kimi-code')
const fixture = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(DIR, file), 'utf8'))
let counter = 0
const context = { now: () => 1_792_841_878_000, newId: () => `01JB${String(++counter).padStart(22, '0')}` }

test('every Kimi Code fixture normalizes to the right kind, or null for an event install does not register', () => {
  const expected: Record<string, EventKind | null> = {
    'docs-constructed-interrupt.json': 'turn_end',
    'docs-constructed-post-tool-use-failure.json': 'tool_result',
    'docs-constructed-post-tool-use.json': 'tool_result',
    'docs-constructed-session-end.json': 'session_end',
    'docs-constructed-session-start.json': 'session_start',
    'docs-constructed-stop.json': 'turn_end',
    'docs-constructed-user-prompt-submit.json': 'user_prompt',
    'docs-pre-tool-use-base.json': null,
  }
  expect(readdirSync(DIR).sort()).toEqual(Object.keys(expected).sort())
  for (const [file, kind] of Object.entries(expected)) {
    const raw = fixture(file)
    const event = normalizeKimiCode(raw, context)
    if (kind === null) {
      expect(event).toBeNull()
      continue
    }
    expect(event).toMatchObject({ kind, host: 'kimi-code', hostSessionId: 'session_abc', cwd: '/path/to/project' })
    expect(validateEvent(event).ok).toBe(true)
  }
  expect(normalizeKimiCode(fixture('docs-constructed-user-prompt-submit.json'), context)).toMatchObject({ promptText: 'Add a test for the parser', isUserTurn: true })
  expect(normalizeKimiCode(fixture('docs-constructed-post-tool-use.json'), context)?.tool).toEqual({ name: 'Bash', input: { command: 'bun test' }, output: '12 pass' })
  expect(normalizeKimiCode(fixture('docs-constructed-post-tool-use-failure.json'), context)?.tool).toMatchObject({ name: 'Bash', isError: true, exitCode: 1 })
  expect(KIMI_CODE_EVENTS).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Interrupt', 'SessionEnd'])
})

test('a minimal or garbage Kimi Code payload gives null and never throws', () => {
  const start = fixture('docs-constructed-session-start.json')
  for (const payload of [null, 'x', [], {}, { hook_event_name: 'Stop' }, { ...start, session_id: '' }, { ...start, cwd: 'relative' },
    { hook_event_name: 'PostToolUse', cwd: '/w', session_id: 's' }]) {
    expect(() => normalizeKimiCode(payload, context)).not.toThrow()
    expect(normalizeKimiCode(payload, context)).toBeNull()
  }
})
