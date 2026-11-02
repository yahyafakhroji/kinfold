import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { prepareForSpool } from '../capture/prepare'
import { type NormalizedEvent, validateEvent } from '../contract/event'
import { FAKE_SECRETS, leakyOutput } from '../../test/fixtures/secrets'
import { codexExitCode, flattenCodexResponse, normalizeCodex } from './codex'
import { AdapterInputError } from './context'

// Built from the documented shapes, never captured from a live Codex (see codex.ts).
const FIXTURES = join(import.meta.dir, '../../test/fixtures/codex')
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))
const NOT_CAPTURED = new Set(['pre-tool-use'])

let counter = 0
const context = { now: () => 1_792_841_878_000, newId: () => `01JC${String(++counter).padStart(22, '0')}`, hostVersion: '0.120.0' }

function normalize(name: string, payload: Record<string, unknown> = fixture(name)): NormalizedEvent {
  const event = normalizeCodex(payload, context)
  if (event === null) throw new Error(`${name} was not captured`)
  return event
}

describe('normalizeCodex on documented payloads', () => {
  const all = readdirSync(FIXTURES).map((file) => file.replace(/\.json$/, ''))

  test('every fixture is marked as built from the docs', () => {
    for (const name of all) expect(String(fixture(name)._source)).toStartWith('docs https://')
  })

  test.each(all.filter((name) => !NOT_CAPTURED.has(name)))('%s becomes a valid codex event with the recorded host version', (name) => {
    const event = normalize(name)
    expect(validateEvent(event).ok).toBe(true)
    expect(event).toMatchObject({ host: 'codex', hostSessionId: fixture(name).session_id, cwd: fixture(name).cwd, hostVersion: '0.120.0' })
  })

  test('PreToolUse is not captured', () => {
    expect(normalizeCodex(fixture('pre-tool-use'), context)).toBeNull()
  })

  test('SessionStart keeps the transcript; SessionEnd with a null transcript has none', () => {
    expect(normalize('session-start')).toMatchObject({ kind: 'session_start', transcriptPath: fixture('session-start').transcript_path })
    const end = normalize('session-end')
    expect(end.kind).toBe('session_end')
    expect(end.transcriptPath).toBeUndefined()
  })

  test('UserPromptSubmit keeps the prompt and uses turn_id as the prompt id', () => {
    const raw = fixture('user-prompt-submit')
    expect(normalize('user-prompt-submit')).toMatchObject({ kind: 'user_prompt', promptText: raw.prompt, isUserTurn: true, hostPromptId: raw.turn_id })
  })

  test('a Bash call takes its exit code from the model-facing text', () => {
    expect(normalize('post-tool-use.bash').tool).toMatchObject({ name: 'Bash', exitCode: 0, input: { command: 'bun test src/store' } })
    expect(normalize('post-tool-use.bash').tool?.isError).toBeUndefined()
    expect(normalize('post-tool-use.bash-failed').tool).toMatchObject({ exitCode: 1, isError: true })
  })

  test('apply_patch keeps its text; MCP results flatten to their text blocks', () => {
    expect(normalize('post-tool-use.apply-patch').tool).toMatchObject({ name: 'apply_patch', output: fixture('post-tool-use.apply-patch').tool_response })
    const mcp = normalize('post-tool-use.mcp').tool
    expect(mcp).toMatchObject({ name: 'mcp__filesystem__read_file', output: '# Shared Agent Memory' })
    expect(mcp?.exitCode).toBeUndefined()
  })

  test('Stop carries the last assistant message and the turn id', () => {
    const raw = fixture('stop')
    expect(normalize('stop')).toMatchObject({ kind: 'turn_end', assistantText: raw.last_assistant_message, hostPromptId: raw.turn_id })
  })

  test('without a recorded version there is no hostVersion', () => {
    const event = normalizeCodex(fixture('session-start'), { now: context.now, newId: context.newId })
    expect(event?.hostVersion).toBeUndefined()
  })
})

describe('normalizeCodex on bad input', () => {
  test('rejects payloads it cannot map and ignores unknown events', () => {
    const good = fixture('session-start')
    expect(() => normalizeCodex([], context)).toThrow(AdapterInputError)
    expect(() => normalizeCodex({ ...good, session_id: '' }, context)).toThrow('session_id')
    expect(() => normalizeCodex({ ...good, cwd: 'relative' }, context)).toThrow('absolute cwd')
    expect(() => normalizeCodex({ ...fixture('post-tool-use.bash'), tool_name: undefined }, context)).toThrow('tool_name')
    expect(normalizeCodex({ ...good, hook_event_name: 'Interrupt' }, context)).toBeNull()
  })
})

describe('helpers', () => {
  test('exit codes from both shell output styles; none from plain text', () => {
    expect(codexExitCode('Process exited with code 2\nOutput:')).toBe(2)
    expect(codexExitCode('Exit code: 127\nWall time: 0.1 seconds\nOutput:')).toBe(127)
    expect(codexExitCode('Success. Updated the following files')).toBeUndefined()
    expect(flattenCodexResponse({ ok: true })).toBe('{"ok":true}')
    expect(flattenCodexResponse(null)).toBe('')
  })
})

describe('edge redaction on Codex events', () => {
  test('no fake secret from tool output, prompt or reply reaches the spooled form', () => {
    const tool = normalize('leaky tool', { ...fixture('post-tool-use.bash'), tool_response: `${leakyOutput()}\nProcess exited with code 0` })
    const prompt = normalize('leaky prompt', { ...fixture('user-prompt-submit'), prompt: `use ${FAKE_SECRETS.openrouter} and ${FAKE_SECRETS.github}` })
    const reply = normalize('leaky reply', { ...fixture('stop'), last_assistant_message: `set ANTHROPIC_API_KEY=${FAKE_SECRETS.anthropic}` })
    const spooled = [tool, prompt, reply].map((event) => JSON.stringify(prepareForSpool(event, { hmacKey: 'test-hmac-key' })))
    for (const text of spooled) {
      for (const [name, secret] of Object.entries(FAKE_SECRETS)) {
        if (name === 'pemBody' || name === 'unnamedRandom') continue
        expect(text).not.toContain(secret)
      }
    }
    expect(spooled[0]).not.toContain(FAKE_SECRETS.pemBody)
  })
})
