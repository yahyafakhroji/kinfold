import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { prepareForSpool } from '../capture/prepare'
import { type NormalizedEvent, validateEvent } from '../contract/event'
import { flattenToolResponse, normalizeClaudeCode } from './claude-code'
import { AdapterInputError } from './context'

const FIXTURES = join(import.meta.dir, '../../test/fixtures/claude-code')
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))

let counter = 0
const context = { now: () => 1_792_841_878_000, newId: () => `01JB${String(++counter).padStart(22, '0')}`, hostVersion: '2.x' }

function normalize(name: string): NormalizedEvent {
  const event = normalizeClaudeCode(fixture(name), context)
  if (event === null) throw new Error(`${name} was not captured`)
  return event
}

describe('normalizeClaudeCode on recorded payloads', () => {
  const captured = readdirSync(FIXTURES).map((file) => file.replace(/\.json$/, '')).filter((name) => name !== 'subagent-stop')

  test.each(captured)('%s becomes a valid event', (name) => {
    expect(validateEvent(normalize(name)).ok).toBe(true)
  })

  test('SessionStart carries session, cwd and transcript', () => {
    const raw = fixture('session-start')
    expect(normalize('session-start')).toMatchObject({
      kind: 'session_start',
      host: 'claude-code',
      hostSessionId: raw.session_id,
      cwd: raw.cwd,
      transcriptPath: raw.transcript_path,
      hostVersion: '2.x',
    })
  })

  test('UserPromptSubmit keeps the prompt and its prompt_id', () => {
    const raw = fixture('user-prompt-submit')
    expect(normalize('user-prompt-submit')).toMatchObject({
      kind: 'user_prompt',
      promptText: raw.prompt,
      isUserTurn: true,
      hostPromptId: raw.prompt_id,
    })
  })

  test('Read flattens to the file content and has no exit code', () => {
    const raw = fixture('post-tool-use.read') as { tool_response: { file: { content: string } } }
    const { tool } = normalize('post-tool-use.read')
    expect(tool?.name).toBe('Read')
    expect(tool?.output).toBe(raw.tool_response.file.content)
    expect(tool?.exitCode).toBeUndefined()
    expect(tool?.isError).toBeUndefined()
  })

  test('a successful Bash call exited 0', () => {
    const raw = fixture('post-tool-use.bash') as { tool_response: { stdout: string } }
    const { tool } = normalize('post-tool-use.bash')
    expect(tool?.exitCode).toBe(0)
    expect(tool?.output).toContain(raw.tool_response.stdout)
  })

  test.each(['post-tool-use-failure.bash', 'post-tool-use-failure.bash-2'])('%s takes its exit code from the error text', (name) => {
    const { tool } = normalize(name)
    expect(tool?.exitCode).toBe(1)
    expect(tool?.isError).toBe(true)
    expect(tool?.output).toStartWith('Exit code 1')
  })

  test('Stop carries the last assistant message', () => {
    expect(normalize('stop')).toMatchObject({ kind: 'turn_end', assistantText: fixture('stop').last_assistant_message })
  })

  test('SessionEnd ends the session and SubagentStop is not captured', () => {
    expect(normalize('session-end').kind).toBe('session_end')
    expect(normalizeClaudeCode(fixture('subagent-stop'), context)).toBeNull()
  })

  test('the RTK-rewritten .env.example read reaches the spool pipeline intact', () => {
    const event = normalize('post-tool-use-failure.bash')
    expect((event.tool?.input as { command: string }).command).toStartWith('rtk read ')
    expect(prepareForSpool(event, { hmacKey: 'test' }).tool?.withheld).toBeUndefined()
  })
})

describe('normalizeClaudeCode on bad input', () => {
  test('rejects payloads it cannot map', () => {
    const good = fixture('session-start')
    expect(() => normalizeClaudeCode('nope', context)).toThrow(AdapterInputError)
    expect(() => normalizeClaudeCode({ ...good, session_id: '' }, context)).toThrow('session_id')
    expect(() => normalizeClaudeCode({ ...good, cwd: 'relative' }, context)).toThrow('absolute cwd')
    expect(() => normalizeClaudeCode({ ...fixture('post-tool-use.bash'), tool_name: undefined }, context)).toThrow('tool_name')
  })

  test('ignores unknown hook events', () => {
    expect(normalizeClaudeCode({ ...fixture('session-start'), hook_event_name: 'Notification' }, context)).toBeNull()
  })
})

describe('flattenToolResponse', () => {
  test('joins stderr after stdout, keeps unknown shapes as JSON, and maps nothing to empty', () => {
    expect(flattenToolResponse({ stdout: 'ok', stderr: 'warn' })).toBe('ok\n[stderr]\nwarn')
    expect(flattenToolResponse({ stdout: 'ok', stderr: '' })).toBe('ok')
    expect(flattenToolResponse({ matches: 2 })).toBe('{"matches":2}')
    expect(flattenToolResponse(null)).toBe('')
  })
})
