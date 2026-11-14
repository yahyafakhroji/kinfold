import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type EventKind, validateEvent } from '../contract/event'
import { AUGGIE_EVENTS, normalizeAuggie } from './auggie'

const DIR = join(import.meta.dir, '../../test/fixtures/auggie')
const fixture = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(DIR, file), 'utf8'))
let counter = 0
const context = { now: () => 1_792_841_878_000, newId: () => `01JB${String(++counter).padStart(22, '0')}` }

test('auggie: each fixture normalizes to the right kind with session, cwd and tool fields', () => {
  const expected: Record<string, EventKind | null> = {
    'docs-constructed-post-tool-use-error.json': 'tool_result',
    'docs-constructed-post-tool-use.json': 'tool_result',
    'docs-constructed-session-end.json': 'session_end',
    'docs-constructed-session-start.json': 'session_start',
    'docs-pre-tool-use.json': null,
    'docs-prompt-submit.json': 'user_prompt',
    'docs-stop.json': 'turn_end',
  }
  expect(readdirSync(DIR).sort()).toEqual(Object.keys(expected).sort())
  for (const [file, kind] of Object.entries(expected)) {
    const event = normalizeAuggie(fixture(file), context)
    if (kind === null) {
      expect(event).toBeNull()
      continue
    }
    expect(event).toMatchObject({ kind, host: 'auggie', hostSessionId: 'conv-xyz789', cwd: '/Users/username/project' })
    expect(validateEvent(event).ok).toBe(true)
  }
  expect(normalizeAuggie(fixture('docs-prompt-submit.json'), context)).toMatchObject({ promptText: 'Add error handling to the login function', isUserTurn: true })
  expect(normalizeAuggie(fixture('docs-constructed-post-tool-use.json'), context)?.tool).toEqual({ name: 'bash', input: { command: 'git status' }, output: 'On branch main\nnothing to commit, working tree clean' })
  expect(normalizeAuggie(fixture('docs-constructed-post-tool-use-error.json'), context)?.tool).toEqual({ name: 'bash', input: { command: 'git pushh' }, output: 'git: \'pushh\' is not a git command.', isError: true })
  expect(AUGGIE_EVENTS).toEqual(['SessionStart', 'PromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'])
})

test('auggie: cwd wins over the first workspace root, which stands in when cwd is missing', () => {
  const start = fixture('docs-constructed-session-start.json')
  expect(normalizeAuggie({ ...start, cwd: '/elsewhere' }, context)?.cwd).toBe('/elsewhere')
  expect(normalizeAuggie({ ...start, cwd: undefined }, context)?.cwd).toBe('/Users/username/project')
})

test('auggie: a minimal or garbage payload gives null and never throws', () => {
  const start = fixture('docs-constructed-session-start.json')
  for (const payload of [null, 'x', [], {}, { hook_event_name: 'SessionStart' }, { ...start, conversation_id: '' }, { ...start, cwd: 'relative', workspace_roots: ['relative'] },
    { hook_event_name: 'PostToolUse', cwd: '/w', conversation_id: 'c' }]) {
    expect(() => normalizeAuggie(payload, context)).not.toThrow()
    expect(normalizeAuggie(payload, context)).toBeNull()
  }
})
