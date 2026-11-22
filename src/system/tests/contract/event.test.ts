import { describe, expect, test } from 'bun:test'
import { type NormalizedEvent, validateEvent } from './event'
import { ulid } from './ulid'

const base = (): NormalizedEvent => ({
  schemaVersion: 1,
  eventId: ulid(),
  host: 'claude-code',
  hostSessionId: 'session-1',
  kind: 'tool_result',
  occurredAt: 1_792_839_465_000,
  cwd: '/Users/dev/repo',
  tool: { name: 'Bash', input: { command: 'ls' }, output: 'a.txt', exitCode: 0 },
})

describe('validateEvent', () => {
  test('accepts a well-formed tool_result', () => {
    const event = base()
    expect(validateEvent(event)).toEqual({ ok: true, event })
  })

  test('accepts a user_prompt with text', () => {
    const { tool: _tool, ...rest } = base()
    expect(validateEvent({ ...rest, kind: 'user_prompt', promptText: 'fix the test', isUserTurn: true }).ok).toBe(true)
  })

  test('rejects non-objects', () => {
    expect(validateEvent(null)).toEqual({ ok: false, errors: ['event must be an object'] })
    expect(validateEvent([base()]).ok).toBe(false)
  })

  test('reports every broken field at once', () => {
    const result = validateEvent({ ...base(), eventId: 'nope', host: 'Claude Code', cwd: 'relative/path', occurredAt: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toEqual([
        'eventId must be a ULID',
        'host must be a lowercase id',
        'occurredAt must be epoch milliseconds',
        'cwd must be an absolute path',
      ])
    }
  })

  test('requires promptText on user_prompt and a tool on tool_result', () => {
    const { tool: _tool, ...rest } = base()
    expect(validateEvent({ ...rest, kind: 'user_prompt' })).toEqual({ ok: false, errors: ['user_prompt needs promptText'] })
    expect(validateEvent({ ...rest })).toEqual({ ok: false, errors: ['tool_result needs a tool object'] })
  })

  test('rejects a tool on other kinds and unknown withheld reasons', () => {
    expect(validateEvent({ ...base(), kind: 'turn_end' }).ok).toBe(false)
    expect(validateEvent({ ...base(), tool: { name: 'Read', input: {}, output: '', withheld: 'because' } }).ok).toBe(false)
  })
})
