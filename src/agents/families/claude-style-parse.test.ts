import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type EventKind, type NormalizedEvent, validateEvent } from '../../contract/event'
import { hookSpecFor } from '../hook-specs'
import type { AgentId } from '../profile'
import { normalizeClaudeStyle } from './claude-style-parse'

const FIXTURES = join(import.meta.dir, '../../../test/fixtures')
const fixture = (host: string, file: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, host, file), 'utf8'))
const filesOf = (host: string): string[] => readdirSync(join(FIXTURES, host)).filter((file) => file.startsWith('docs-')).sort()

let counter = 0
const context = { now: () => 1_792_841_878_000, newId: () => `01JB${String(++counter).padStart(22, '0')}` }

const KIND_BY_NAME: Readonly<Record<string, EventKind>> = {
  'session-start': 'session_start',
  'user-prompt-submit': 'user_prompt',
  'post-tool-use': 'tool_result',
  'post-tool-use-failure': 'tool_result',
  stop: 'turn_end',
  'session-end': 'session_end',
}
const kindOf = (file: string): EventKind | undefined => KIND_BY_NAME[file.replace(/^docs-(constructed-)?/, '').replace(/\.json$/, '')]

function normalize(host: AgentId, payload: unknown): NormalizedEvent | null {
  const spec = hookSpecFor(host)
  if (spec === null) throw new Error(`${host} has no hook spec`)
  return spec.normalize(payload, context)
}

/** Each fixture: the event it becomes, with session, cwd and tool fields from the payload. */
function expectCaptured(host: AgentId, file: string): void {
  const raw = fixture(host, file)
  const event = normalize(host, raw)
  expect({ file, kind: event?.kind }).toEqual({ file, kind: kindOf(file) })
  if (event === null) return
  expect(validateEvent(event).ok).toBe(true)
  expect(event).toMatchObject({ host, hostSessionId: raw.session_id, cwd: raw.cwd ?? raw.project_path })
  if (event.kind === 'tool_result') expect(event.tool).toMatchObject({ name: raw.tool_name, input: raw.tool_input })
  if (event.kind === 'user_prompt') expect(event).toMatchObject({ promptText: raw.prompt, isUserTurn: true })
}

const MINIMAL = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd']

function expectMinimalSafe(host: AgentId): void {
  for (const name of MINIMAL) {
    let event: NormalizedEvent | null = null
    expect(() => {
      event = normalize(host, { hook_event_name: name })
    }).not.toThrow()
    expect(event).toBeNull()
  }
  for (const odd of ['nope', null, 42, [], { hook_event_name: 'PostToolUse', session_id: 's', cwd: '/p' }, { hook_event_name: 'SessionStart', session_id: 's', cwd: 'relative' }]) {
    expect(() => normalize(host, odd)).not.toThrow()
    expect(normalize(host, odd)).toBeNull()
  }
}

describe('qwen-code', () => {
  test('qwen-code: each fixture normalizes to the right kind with session, cwd and tool fields', () => {
    const files = filesOf('qwen-code')
    expect(files.length).toBe(6)
    for (const file of files) expectCaptured('qwen-code', file)
    expect(normalize('qwen-code', fixture('qwen-code', 'docs-constructed-post-tool-use-failure.json'))?.tool).toMatchObject({ isError: true, output: 'Command failed' })
    expect(normalize('qwen-code', fixture('qwen-code', 'docs-constructed-stop.json'))).toMatchObject({ assistantText: 'Added the test.', hostPromptId: 'qwen-prompt-0001' })
  })

  test('qwen-code: a minimal payload with only hook_event_name returns an event with fallbacks or null and never throws', () => expectMinimalSafe('qwen-code'))
})

describe('factory-droid', () => {
  test('factory-droid: each fixture normalizes to the right kind with session, cwd and tool fields', () => {
    const files = filesOf('factory-droid')
    expect(files.length).toBe(5)
    for (const file of files) expectCaptured('factory-droid', file)
    expect(normalize('factory-droid', fixture('factory-droid', 'docs-constructed-post-tool-use.json'))?.tool?.output).toBe('File created')
  })

  test('factory-droid: a minimal payload with only hook_event_name returns an event with fallbacks or null and never throws', () => expectMinimalSafe('factory-droid'))
})

describe('devin', () => {
  test('devin: each fixture normalizes to the right kind with session, cwd and tool fields', () => {
    const files = filesOf('devin')
    expect(files.length).toBe(5)
    for (const file of files) expectCaptured('devin', file)
    // tool_response is { success, output, error }; a failed call carries its error text.
    expect(normalize('devin', fixture('devin', 'docs-constructed-post-tool-use.json'))?.tool).toMatchObject({ isError: true, output: 'exit status 1' })
  })

  test('devin: a minimal payload with only hook_event_name returns an event with fallbacks or null and never throws', () => expectMinimalSafe('devin'))
})

describe('junie', () => {
  test('junie: each fixture normalizes to the right kind with session, cwd and tool fields', () => {
    for (const file of ['docs-session-start.json', 'docs-user-prompt-submit.json']) expectCaptured('junie', file)
    // The docs' own examples for these events carry no session_id or cwd, so there is nothing to file them under.
    for (const file of ['docs-post-tool-use.json', 'docs-stop.json', 'docs-session-end.json']) expect(normalize('junie', fixture('junie', file))).toBeNull()
    const start = fixture('junie', 'docs-session-start.json')
    const withSession = { ...fixture('junie', 'docs-post-tool-use.json'), session_id: start.session_id, cwd: start.cwd }
    expect(normalize('junie', withSession)?.tool).toMatchObject({ name: 'Write', output: '…' })
  })

  test('junie: project_path stands in when cwd is missing', () => {
    const { cwd: _cwd, ...noCwd } = fixture('junie', 'docs-user-prompt-submit.json')
    expect(normalize('junie', noCwd)?.cwd).toBe('/path/to/project')
  })

  test('junie: a minimal payload with only hook_event_name returns an event with fallbacks or null and never throws', () => expectMinimalSafe('junie'))
})

describe('copilot', () => {
  test('copilot: each fixture normalizes to the right kind with session, cwd and tool fields', () => {
    const files = filesOf('copilot')
    expect(files.length).toBe(6)
    for (const file of files) expectCaptured('copilot', file)
    expect(normalize('copilot', fixture('copilot', 'docs-constructed-post-tool-use.json'))?.tool).toEqual({ name: 'bash', input: { command: 'ls' }, output: 'README.md' })
    expect(normalize('copilot', fixture('copilot', 'docs-constructed-post-tool-use-failure.json'))?.tool).toMatchObject({ isError: true })
    expect(normalize('copilot', fixture('copilot', 'docs-constructed-stop.json'))?.transcriptPath).toContain('copilot-session-0001')
  })

  test('copilot: a tool_result that is not a success is an error', () => {
    const raw = fixture('copilot', 'docs-constructed-post-tool-use.json')
    const denied = { ...raw, tool_result: { result_type: 'failure', text_result_for_llm: 'denied' } }
    expect(normalize('copilot', denied)?.tool).toMatchObject({ isError: true, output: 'denied' })
  })

  test('copilot: a minimal payload with only hook_event_name returns an event with fallbacks or null and never throws', () => expectMinimalSafe('copilot'))
})

describe('normalizeClaudeStyle', () => {
  test('maps only the events in its table, and labels the event with the host it was built for', () => {
    const normalize = normalizeClaudeStyle({ Begin: 'session_start' }, 'qwen-code')
    expect(normalize({ hook_event_name: 'Begin', session_id: 's', cwd: '/p' }, context)).toMatchObject({ kind: 'session_start', host: 'qwen-code' })
    expect(normalize({ hook_event_name: 'SessionStart', session_id: 's', cwd: '/p' }, context)).toBeNull()
  })
})
