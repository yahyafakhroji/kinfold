import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { prepareForSpool } from '../capture/prepare'
import { type NormalizedEvent, validateEvent } from '../contract/event'
import { FAKE_SECRETS, leakyOutput } from '../../test/fixtures/secrets'
import { AdapterInputError } from './context'
import { flattenCursorOutput, normalizeCursor } from './cursor'

// Built from the documented shapes; the two marked "capture shape" follow public
// captures from real Cursor runs, with made-up values (see cursor.ts).
const FIXTURES = join(import.meta.dir, '../../test/fixtures/cursor')
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))
const NOT_CAPTURED = new Set(['before-shell-execution', 'stop.completed'])
const ROOT = '/Users/dev/Dev/rea/shared-agent-memory'

let counter = 0
const context = { now: () => 1_792_841_878_000, newId: () => `01JD${String(++counter).padStart(22, '0')}`, hostVersion: '0.0.1-recorded' }

function normalize(name: string, payload: Record<string, unknown> = fixture(name)): NormalizedEvent {
  const event = normalizeCursor(payload, context)
  if (event === null) throw new Error(`${name} was not captured`)
  return event
}

describe('normalizeCursor on documented payloads', () => {
  const all = readdirSync(FIXTURES).map((file) => file.replace(/\.json$/, ''))

  test('every fixture names its source: the docs or a public capture shape', () => {
    for (const name of all) expect(String(fixture(name)._source)).toMatch(/^(docs https:\/\/cursor\.com\/|capture shape: Cursor )/)
  })

  test.each(all.filter((name) => !NOT_CAPTURED.has(name)))('%s becomes a valid cursor event keyed on conversation_id', (name) => {
    const event = normalize(name)
    expect(validateEvent(event).ok).toBe(true)
    expect(event).toMatchObject({ host: 'cursor', hostSessionId: fixture(name).conversation_id, cwd: ROOT, hostPromptId: fixture(name).generation_id })
  })

  test('host_version comes from cursor_version, over the recorded one', () => {
    expect(normalize('session-start').hostVersion).toBe('2.4.21')
    const { cursor_version: _dropped, ...noVersion } = fixture('session-start')
    expect(normalize('session-start', noVersion).hostVersion).toBe('0.0.1-recorded')
  })

  test('the gates and a completed stop are not captured', () => {
    for (const name of NOT_CAPTURED) expect(normalizeCursor(fixture(name), context)).toBeNull()
  })

  test('session start and end, prompt text, transcript', () => {
    expect(normalize('session-start')).toMatchObject({ kind: 'session_start', transcriptPath: fixture('session-start').transcript_path })
    expect(normalize('session-end').kind).toBe('session_end')
    expect(normalize('before-submit-prompt')).toMatchObject({ kind: 'user_prompt', promptText: fixture('before-submit-prompt').prompt, isUserTurn: true })
  })

  test('tool output is unwrapped from its JSON string, with the exit code when it is there', () => {
    expect(normalize('post-tool-use.shell').tool).toMatchObject({ name: 'Shell', output: ' 12 pass\n 0 fail\n', exitCode: 0, input: { command: 'bun test src/store' } })
    expect(normalize('post-tool-use.shell-cli').tool).toMatchObject({ name: 'Shell', output: ' 12 pass\n 0 fail\n', exitCode: 0 })
    expect(normalize('post-tool-use.read').tool?.exitCode).toBeUndefined()
  })

  test('real Read output carries no file text: the path and length stay as the raw JSON', () => {
    expect(normalize('post-tool-use.read').tool).toMatchObject({ name: 'Read', output: String(fixture('post-tool-use.read').tool_output) })
  })

  test('captured shapes: no cwd (Read) and an empty cwd (CLI Shell) fall back to the workspace root; a null transcript_path is dropped', () => {
    expect(normalize('post-tool-use.read')).toMatchObject({ cwd: ROOT, hostVersion: '3.12.17' })
    expect(normalize('post-tool-use.read').transcriptPath).toBeUndefined()
    expect(normalize('post-tool-use.shell-cli')).toMatchObject({ cwd: ROOT, hostVersion: '2026.10.19-6bbf2c4' })
  })

  test('postToolUseFailure is an error carrying the error message', () => {
    expect(normalize('post-tool-use-failure.shell').tool).toMatchObject({ isError: true, output: fixture('post-tool-use-failure.shell').error_message })
  })

  test('afterAgentResponse ends the turn with its text; an aborted stop ends it without', () => {
    expect(normalize('after-agent-response')).toMatchObject({ kind: 'turn_end', assistantText: fixture('after-agent-response').text })
    const aborted = normalize('stop.aborted')
    expect(aborted.kind).toBe('turn_end')
    expect(aborted.assistantText).toBeUndefined()
  })
})

describe('normalizeCursor on bad input', () => {
  test('rejects payloads it cannot map and ignores unknown events', () => {
    const good = fixture('session-start')
    expect(() => normalizeCursor('nope', context)).toThrow(AdapterInputError)
    expect(() => normalizeCursor({ ...good, conversation_id: '', session_id: undefined }, context)).toThrow('conversation_id')
    expect(() => normalizeCursor({ ...good, workspace_roots: ['relative'] }, context)).toThrow('absolute cwd')
    expect(() => normalizeCursor({ ...fixture('post-tool-use.shell'), tool_name: '' }, context)).toThrow('tool_name')
    expect(normalizeCursor({ ...good, hook_event_name: 'afterFileEdit' }, context)).toBeNull()
  })
})

describe('flattenCursorOutput', () => {
  test('keeps unparseable text, unwraps strings, falls back to the raw JSON', () => {
    expect(flattenCursorOutput('plain text')).toEqual({ output: 'plain text' })
    expect(flattenCursorOutput('"quoted"')).toEqual({ output: 'quoted' })
    expect(flattenCursorOutput('{"stdout":"x","exit_code":2}')).toEqual({ output: 'x', exitCode: 2 })
    expect(flattenCursorOutput('{"files":3}')).toEqual({ output: '{"files":3}' })
    expect(flattenCursorOutput(undefined)).toEqual({ output: '' })
  })
})

describe('edge redaction on Cursor events', () => {
  test('no fake secret from tool output, prompt or reply reaches the spooled form', () => {
    const tool = normalize('leaky tool', { ...fixture('post-tool-use.shell'), tool_output: JSON.stringify({ output: leakyOutput(), exitCode: 0 }) })
    const prompt = normalize('leaky prompt', { ...fixture('before-submit-prompt'), prompt: `use ${FAKE_SECRETS.openrouter} and ${FAKE_SECRETS.aws}` })
    const reply = normalize('leaky reply', { ...fixture('after-agent-response'), text: `token ${FAKE_SECRETS.slack}` })
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
