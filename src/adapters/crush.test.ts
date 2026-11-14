import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type EventKind, validateEvent } from '../contract/event'
import { CRUSH_EVENTS, normalizeCrush } from './crush'

const DIR = join(import.meta.dir, '../../test/fixtures/crush')
const fixture = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(DIR, file), 'utf8'))
let counter = 0
const context = { now: () => 1_792_841_878_000, newId: () => `01JB${String(++counter).padStart(22, '0')}` }

test('crush: each fixture normalizes to the right kind with session, cwd and tool fields', () => {
  const expected: Record<string, EventKind | null> = {
    'docs-constructed-interrupt.json': 'turn_end',
    'docs-constructed-post-tool-use-failure.json': 'tool_result',
    'docs-constructed-post-tool-use.json': 'tool_result',
    'docs-constructed-pre-tool-use.json': null,
    'docs-constructed-session-end.json': 'session_end',
    'docs-constructed-session-start.json': 'session_start',
    'docs-constructed-stop-failure.json': 'turn_end',
    'docs-constructed-turn-end.json': 'turn_end',
    // TurnStart carries no prompt text, so it is not recorded as a prompt.
    'docs-constructed-turn-start.json': null,
  }
  expect(readdirSync(DIR).sort()).toEqual(Object.keys(expected).sort())
  for (const [file, kind] of Object.entries(expected)) {
    const event = normalizeCrush(fixture(file), context)
    if (kind === null) {
      expect(event).toBeNull()
      continue
    }
    expect(event).toMatchObject({ kind, host: 'crush', hostSessionId: '313909e', cwd: '/home/user/project' })
    expect(validateEvent(event).ok).toBe(true)
  }
  expect(normalizeCrush(fixture('docs-constructed-post-tool-use.json'), context)?.tool).toEqual({ name: 'bash', input: { command: 'npm test' }, output: 'PASS\nok  \texample.com/testproject\t0.004s' })
  expect(normalizeCrush(fixture('docs-constructed-post-tool-use-failure.json'), context)?.tool).toEqual({ name: 'bash', input: { command: 'npm test' }, output: 'exit status 1\nFAIL\t...', isError: true })
  expect(normalizeCrush(fixture('docs-constructed-turn-end.json'), context)).toMatchObject({ assistantText: 'Here\'s what I found...' })
  expect(CRUSH_EVENTS).toEqual(['SessionStart', 'PostToolUse', 'PostToolUseFailure', 'TurnEnd', 'StopFailure', 'Interrupt', 'SessionEnd'])
})

test('crush: a minimal or garbage payload gives null and never throws', () => {
  const start = fixture('docs-constructed-session-start.json')
  for (const payload of [null, 'x', [], {}, { hook_event_name: 'SessionStart' }, { ...start, session_id: '' }, { ...start, cwd: 'relative' },
    { hook_event_name: 'PostToolUse', cwd: '/w', session_id: 's' }]) {
    expect(() => normalizeCrush(payload, context)).not.toThrow()
    expect(normalizeCrush(payload, context)).toBeNull()
  }
})
