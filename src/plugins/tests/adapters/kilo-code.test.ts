// Kilo Code's hook payloads -> NormalizedEvent, against payloads recorded from
// a live Kilo CLI 7.8.27 run (test/fixtures/kilo-code/).

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type NormalizedEvent, validateEvent } from '../../../system/contract/event'
import { type KiloMapper, KILO_HOST, createKiloMapper } from '../../adapters/kilo-code'

const FIXTURES = join(import.meta.dir, '../../../../test/fixtures/kilo-code')
const fixture = <T = Record<string, any>>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T

const DIRECTORY = '/Users/me/project'
const SESSION = 'ses_e1e6d0192ffe7pZ5J19xRJk76C'
const NOW = 1_794_800_000_000
let counter: number
let mapper: KiloMapper

beforeEach(() => {
  counter = 0
  mapper = createKiloMapper({ directory: DIRECTORY, now: () => NOW, newId: () => `01JB${String(++counter).padStart(22, '0')}` })
})

const valid = (events: readonly NormalizedEvent[]): NormalizedEvent[] => {
  for (const event of events) expect(validateEvent(event)).toMatchObject({ ok: true })
  return [...events]
}
const created = (): NormalizedEvent[] => valid(mapper.event(fixture('event.session.created')))
const prompt = (name = 'chat.message'): NormalizedEvent[] => {
  const recorded = fixture(name)
  return valid(mapper.chatMessage(recorded.input, recorded.output))
}

describe('session start', () => {
  test('session.created starts the session once, with Kilo\'s version, directory and time', () => {
    const [start, ...rest] = created()
    expect(rest).toEqual([])
    expect(start).toMatchObject({ kind: 'session_start', host: KILO_HOST, hostSessionId: SESSION, cwd: DIRECTORY, hostVersion: '7.8.27', occurredAt: 1794785869421 })
    expect(created()).toEqual([])
  })

  test('a prompt in a session whose start this plugin never saw starts it first', () => {
    const events = prompt()
    expect(events.map((event) => event.kind)).toEqual(['session_start', 'user_prompt'])
    expect(events[0]!.occurredAt).toBe(events[1]!.occurredAt)
    // And a session.created that arrives afterwards is not a second start.
    expect(created()).toEqual([])
  })

  test('the events of a session take its directory, not the one the plugin loaded in', () => {
    const elsewhere = fixture('event.session.created')
    elsewhere.properties.info.directory = '/Users/me/other'
    mapper.event(elsewhere)
    expect(prompt()[0]!.cwd).toBe('/Users/me/other')
  })
})

describe('prompts', () => {
  test('chat.message is the user\'s prompt, by its message id and time', () => {
    created()
    const [event, ...rest] = prompt()
    expect(rest).toEqual([])
    expect(event).toMatchObject({
      kind: 'user_prompt', host: KILO_HOST, hostSessionId: SESSION, promptText: 'how do we pin bun in CI?', isUserTurn: true,
      hostPromptId: 'msg_1e192fe7d001mVkFE9r3rMzZZ1', occurredAt: 1794785869437, cwd: DIRECTORY, hostVersion: '7.8.27',
    })
  })

  test('text parts are joined; parts Kilo added itself and a prompt with no text are left out', () => {
    created()
    const recorded = fixture('chat.message')
    const part = recorded.output.parts[0]
    const joined = mapper.chatMessage(recorded.input, { ...recorded.output, parts: [part, { type: 'file', url: 'file:///x' }, { ...part, text: 'second part' }, { ...part, text: 'added by Kilo', synthetic: true }] })
    expect(joined[0]!.promptText).toBe('how do we pin bun in CI?\nsecond part')
    expect(mapper.chatMessage(recorded.input, { ...recorded.output, parts: [{ ...part, text: '   ' }] })).toEqual([])
    expect(mapper.chatMessage(recorded.input, { ...recorded.output, parts: [] })).toEqual([])
  })

  test('a payload that is not Kilo\'s shape maps to nothing', () => {
    for (const [input, output] of [[null, null], [{}, {}], [{ sessionID: 5 }, { parts: [] }], [{ sessionID: SESSION }, { parts: 'no' }], [{ sessionID: SESSION }, null]]) {
      expect(mapper.chatMessage(input, output)).toEqual([])
    }
    for (const event of [null, 7, {}, { type: 'session.created' }, { type: 'session.created', properties: {} }, { type: 'session.idle', properties: { sessionID: 9 } }]) {
      expect(mapper.event(event)).toEqual([])
    }
    expect(mapper.toolAfter(null, null)).toEqual([])
    expect(mapper.toolAfter({ sessionID: SESSION }, { output: 'x' })).toEqual([])
  })
})

describe('tool results', () => {
  test('tool.execute.after carries the tool, its arguments and its text output', () => {
    created()
    const recorded = fixture('tool.execute.after.read')
    const [event, ...rest] = valid(mapper.toolAfter(recorded.input, recorded.output))
    expect(rest).toEqual([])
    expect(event).toMatchObject({ kind: 'tool_result', host: KILO_HOST, hostSessionId: SESSION, cwd: DIRECTORY, occurredAt: NOW })
    expect(event!.tool).toEqual({ name: 'read', input: { filePath: '/Users/me/project/README.md' }, output: recorded.output.output })
    expect(event!.tool!.output).toContain('# demo')
  })

  test('a relative path is resolved against the session\'s directory, and a failed shell call is an error', () => {
    created()
    const recorded = fixture('tool.execute.after.read')
    const relative = mapper.toolAfter({ ...recorded.input, args: { filePath: 'src/a.ts' } }, recorded.output)
    expect(relative[0]!.tool!.input).toEqual({ filePath: resolve(DIRECTORY, 'src/a.ts') })
    const failed = mapper.toolAfter({ ...recorded.input, tool: 'bash', args: { command: 'false' } }, { title: 'false', output: '', metadata: { exit: 1 } })
    expect(failed[0]!.tool).toMatchObject({ name: 'bash', exitCode: 1, isError: true })
    const passed = mapper.toolAfter({ ...recorded.input, tool: 'bash', args: { command: 'true' } }, { title: 'true', output: 'ok', metadata: { exit: 0 } })
    expect(passed[0]!.tool).toEqual({ name: 'bash', input: { command: 'true' }, output: 'ok', exitCode: 0 })
  })

  test('a tool result with no usable output is recorded with an empty one', () => {
    created()
    const recorded = fixture('tool.execute.after.read')
    expect(mapper.toolAfter(recorded.input, { title: 't' })[0]!.tool!.output).toBe('')
    expect(mapper.toolAfter({ ...recorded.input, args: 'not an object' }, recorded.output)[0]!.tool!.input).toEqual({})
  })
})

describe('turn end', () => {
  test('session.idle after a prompt ends the turn with the reply Kilo completed last', () => {
    created()
    prompt()
    const text = fixture('experimental.text.complete')
    mapper.textComplete(text.input, { text: 'an earlier part of the reply' })
    mapper.textComplete(text.input, text.output)
    const [end, ...rest] = valid(mapper.event(fixture('event.session.idle')))
    expect(rest).toEqual([])
    expect(end).toMatchObject({ kind: 'turn_end', host: KILO_HOST, hostSessionId: SESSION, assistantText: 'Fake model reply: pinned with .bun-version.', occurredAt: NOW, cwd: DIRECTORY })
  })

  test('an idle with no prompt before it is not a turn, and a reply is not carried into the next turn', () => {
    created()
    expect(mapper.event(fixture('event.session.idle'))).toEqual([])
    prompt()
    const text = fixture('experimental.text.complete')
    mapper.textComplete(text.input, text.output)
    expect(mapper.event(fixture('event.session.idle'))).toHaveLength(1)
    expect(mapper.event(fixture('event.session.idle'))).toEqual([])
    prompt('chat.message-2')
    const second = mapper.event(fixture('event.session.idle'))
    expect(second).toHaveLength(1)
    expect(second[0]!.assistantText).toBeUndefined()
  })

  test('the other bus events Kilo sends map to nothing', () => {
    created()
    prompt()
    for (const name of ['event.session.status', 'event.session.updated', 'event.message.updated.assistant']) expect(mapper.event(fixture(name))).toEqual([])
  })
})

test('the mapper forgets its oldest sessions rather than growing without end', () => {
  const template = fixture('event.session.created')
  for (let index = 0; index < 300; index += 1) {
    const event = structuredClone(template)
    event.properties.sessionID = `ses_${index}`
    event.properties.info.id = `ses_${index}`
    expect(mapper.event(event)).toHaveLength(1)
  }
  expect(mapper.trackedSessions()).toBeLessThanOrEqual(256)
})

test('a session still in use is not the one forgotten when the mapper is full', () => {
  // The first session, then enough others to fill the map, with the first one prompting in between.
  created()
  const template = fixture('event.session.created')
  const open = (index: number): void => {
    const event = structuredClone(template)
    event.properties.sessionID = `ses_${index}`
    event.properties.info.id = `ses_${index}`
    mapper.event(event)
  }
  for (let index = 0; index < 255; index += 1) open(index)
  expect(prompt().map((event) => event.kind)).toEqual(['user_prompt'])
  for (let index = 255; index < 300; index += 1) open(index)
  expect(mapper.knows(SESSION)).toBe(true)
  // No second session_start for it: the state was kept.
  expect(prompt().map((event) => event.kind)).toEqual(['user_prompt'])
  expect(mapper.knows('ses_0')).toBe(false)
})
