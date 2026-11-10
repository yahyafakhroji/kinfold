import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { prepareForSpool } from '../capture/prepare'
import { type NormalizedEvent, validateEvent } from '../contract/event'
import { AdapterInputError } from './context'
import {
  createOpenCodeBusMapper,
  extractResultText,
  normalizeOpenCodePrompt,
  normalizeOpenCodeToolAfter,
} from './opencode'

const FIXTURES = join(import.meta.dir, '../../test/fixtures/opencode')
const fixture = <T = Record<string, unknown>>(name: string): T =>
  (JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as { payload: T }).payload

const directory = fixture<{ location: { directory: string } }>('setup.context').location.directory
let counter = 0
const context = { directory, now: () => 1_792_841_900_000, newId: () => `01JB${String(++counter).padStart(22, '0')}` }

const tool = (name: string): NonNullable<NormalizedEvent['tool']> => {
  const event = normalizeOpenCodeToolAfter(fixture(name), context)
  expect(validateEvent(event).ok).toBe(true)
  return event.tool!
}

describe('normalizeOpenCodeToolAfter on recorded events', () => {
  test('read resolves its relative path against the checkout', () => {
    const read = tool('tool.execute.after.read')
    expect(read.name).toBe('read')
    expect(read.input).toEqual({ path: resolve(directory, 'package.json') })
    expect(read.output).toContain('"name": "shared-agent-memory"')
    expect(read.exitCode).toBeUndefined()
    expect(read.isError).toBeUndefined()
  })

  test('a shell call with exit 1 is an error even though OpenCode says "completed"', () => {
    const failed = tool('tool.execute.after.shell')
    expect(failed.exitCode).toBe(1)
    expect(failed.isError).toBe(true)
    expect(failed.output).toContain('No such file or directory')
  })

  test('a shell call with exit 0 is not an error', () => {
    const passed = tool('tool.execute.after.shell-2')
    expect(passed.exitCode).toBe(0)
    expect(passed.isError).toBeUndefined()
  })

  test('glob keeps its pattern and its text result', () => {
    const glob = tool('tool.execute.after.glob')
    expect(glob.input).toEqual({ pattern: '.env*' })
    expect(glob.output).toBe('No files found')
  })

  test('a resolved path lets project-anchored .memignore rules apply', () => {
    const event = normalizeOpenCodeToolAfter({ ...fixture<Record<string, unknown>>('tool.execute.after.read'), input: { path: 'secrets/prod.yaml' } }, context)
    // Path rules match the slash form of the resolved path, whatever separator the OS uses.
    const secrets = `${resolve(directory, 'secrets').replace(/\\/g, '/')}/`
    const memignore = [new RegExp(`^${secrets.replace(/[/.]/g, '\\$&')}`)]
    expect(prepareForSpool(event, { hmacKey: 'test', extraPathPatterns: memignore }).tool?.withheld).toBe('sensitive_path')
  })

  test('an error with no result text becomes the output', () => {
    const event = normalizeOpenCodeToolAfter({ tool: 'write', sessionID: 'ses_x', status: 'error', error: { message: 'denied' } }, context)
    expect(event.tool).toMatchObject({ output: 'denied', isError: true })
  })
})

describe('normalizeOpenCodePrompt', () => {
  test('keeps the recorded prompt and its message id', () => {
    const raw = fixture<{ prompt: { text: string }; messageID: string }>('session.prompt')
    const event = normalizeOpenCodePrompt(raw, context)
    expect(event).toMatchObject({ kind: 'user_prompt', promptText: raw.prompt.text, isUserTurn: true, hostPromptId: raw.messageID })
    expect(validateEvent(event).ok).toBe(true)
  })

  test('returns null for an empty prompt', () => {
    expect(normalizeOpenCodePrompt({ sessionID: 'ses_x', prompt: { text: '  ' } }, context)).toBeNull()
  })
})

describe('createOpenCodeBusMapper', () => {
  test('session.created starts a session at the bus time', () => {
    const raw = fixture<{ created: number; location: { directory: string } }>('bus.session.created')
    const event = createOpenCodeBusMapper(context)(raw)
    expect(event).toMatchObject({ kind: 'session_start', occurredAt: raw.created, cwd: raw.location.directory })
    expect(validateEvent(event).ok).toBe(true)
  })

  test('a repeated session.created starts the session once (opencode run sends it three times)', () => {
    const map = createOpenCodeBusMapper(context)
    const raw = fixture('bus.session.created')
    expect(map(raw)?.kind).toBe('session_start')
    expect(map(raw)).toBeNull()
    expect(map(raw)).toBeNull()
  })

  test('an unlocated turn end takes the directory of the session, not the mapper', () => {
    const map = createOpenCodeBusMapper({ ...context, directory: '/some/other/instance' })
    const created = fixture<{ location: { directory: string } }>('bus.session.created')
    map(created)
    expect(map(fixture('bus.session.execution.succeeded'))?.cwd).toBe(created.location.directory)
  })

  test('the reply from text.ended lands on the next execution.succeeded, once', () => {
    const map = createOpenCodeBusMapper(context)
    const reply = fixture<{ data: { text: string } }>('bus.session.text.ended')
    const succeeded = fixture<{ created: number }>('bus.session.execution.succeeded')

    expect(map(reply)).toBeNull()
    const turnEnd = map(succeeded)
    expect(turnEnd).toMatchObject({ kind: 'turn_end', assistantText: reply.data.text, occurredAt: succeeded.created, cwd: directory })
    expect(validateEvent(turnEnd).ok).toBe(true)
    expect(map(succeeded)?.assistantText).toBeUndefined()
  })

  test('session.deleted ends the session; unrelated and malformed envelopes map to nothing', () => {
    const map = createOpenCodeBusMapper(context)
    const sessionId = fixture<{ data: { sessionID: string } }>('bus.session.created').data.sessionID
    expect(map({ type: 'session.deleted', created: 1_792_841_999_000, data: { sessionID: sessionId } })?.kind).toBe('session_end')
    expect(map(fixture('bus.shell.exited'))).toBeNull()
    expect(map({ type: 'session.created' })).toBeNull()
    expect(map('nope')).toBeNull()
  })
})

describe('bad input', () => {
  test('rejects tool events without session or tool, and a context without a directory', () => {
    expect(() => normalizeOpenCodeToolAfter({ tool: 'read' }, context)).toThrow(AdapterInputError)
    expect(() => normalizeOpenCodeToolAfter(fixture('tool.execute.after.read'), { ...context, directory: 'relative' })).toThrow('absolute directory')
  })

  test('extractResultText falls back to output strings', () => {
    expect(extractResultText({ output: 'plain' })).toBe('plain')
    expect(extractResultText({ output: { output: 'nested' } })).toBe('nested')
    expect(extractResultText(undefined)).toBe('')
  })
})

describe('OpenCode host_version', () => {
  test('session.created data.version stamps that session, over the recorded version, for bus and hook events alike', () => {
    const shared = { ...context, hostVersion: '2.0.0-recorded', sessionVersions: new Map<string, string>() }
    const created = fixture<{ data: { sessionID: string } }>('bus.session.created')
    const start = createOpenCodeBusMapper(shared)(created)
    expect(start).toMatchObject({ kind: 'session_start', hostVersion: '2.1.4' })
    const prompt = normalizeOpenCodePrompt({ ...fixture<Record<string, unknown>>('session.prompt'), sessionID: created.data.sessionID }, shared)
    expect(prompt?.hostVersion).toBe('2.1.4')
    const other = normalizeOpenCodeToolAfter({ ...fixture<Record<string, unknown>>('tool.execute.after.read'), sessionID: 'ses_other' }, shared)
    expect(other.hostVersion).toBe('2.0.0-recorded')
  })

  test('without either source there is no hostVersion', () => {
    expect(createOpenCodeBusMapper(context)(fixture('bus.session.created'))?.hostVersion).toBeUndefined()
  })
})
