import { afterEach, beforeEach, expect, test } from 'bun:test'
import { processSessionBatch } from '../process'
import { type TempStore, T0, openTempStore, seedEvent, seedSession } from '../test-support'
import { ObserverError, type ObserverPrompt } from '../types'
import { createRunner } from '.'
import { type FetchFn, OPENROUTER_ENDPOINT, createOpenRouterRunner } from './openrouter'

const KEY = 'sk-or-v1-fake-test-key-0000000000000000000000000000'
const PROMPT: ObserverPrompt = { system: 'SYSTEM RULES', user: 'EVENTS', eventIds: ['01JA'] }

interface Call {
  url: string
  init: RequestInit
}

function fakeFetch(response: () => Response): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return response()
    },
  }
}

const completion = (content: string): Response =>
  Response.json({ model: 'anthropic/claude-haiku', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 5, completion_tokens: 7 } })

test('posts model openrouter/auto with the Bearer key to the chat completions endpoint', async () => {
  const { fetch, calls } = fakeFetch(() => completion('{}'))
  const result = await createOpenRouterRunner({ apiKey: KEY, model: 'openrouter/auto', fetch }).run(PROMPT)

  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toBe(OPENROUTER_ENDPOINT)
  expect(calls[0]!.init.method).toBe('POST')
  expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
  const body = JSON.parse(calls[0]!.init.body as string)
  expect(body.model).toBe('openrouter/auto')
  expect(body.messages).toEqual([{ role: 'system', content: 'SYSTEM RULES' }, { role: 'user', content: 'EVENTS' }])
  expect(result).toEqual({ text: '{}', model: 'anthropic/claude-haiku', usage: { inputTokens: 5, outputTokens: 7 } })
})

test.each([
  [() => new Response('{"error":{"message":"bad key"}}', { status: 401 }), 'http_error: openrouter answered 401'],
  [() => Response.json({ choices: [] }), 'bad_response: completion has no message text'],
  [() => new Response('<html>', { status: 200 }), 'bad_response: openrouter body is not JSON'],
])('a failure is named and never carries the key or the body', async (response, message) => {
  const { fetch } = fakeFetch(response)
  let caught: unknown
  try {
    await createOpenRouterRunner({ apiKey: KEY, model: 'openrouter/auto', fetch }).run(PROMPT)
  } catch (error: unknown) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ObserverError)
  expect((caught as Error).message).toBe(message)
  expect((caught as Error).message).not.toContain(KEY)
})

test('a network error becomes http_error with only the error name', async () => {
  const fetch: FetchFn = async () => {
    throw new TypeError(`connect failed with ${KEY}`)
  }
  await expect(createOpenRouterRunner({ apiKey: KEY, model: 'openrouter/auto', fetch }).run(PROMPT)).rejects.toThrow('http_error: request failed (TypeError)')
})

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('sam-openrouter-')
})
afterEach(() => temp.cleanup())

test('through the daemon path the key comes from the credential provider and never reaches logs or the store', async () => {
  const session = seedSession(temp.store, 'opencode', 'o1')
  seedEvent(temp.store, session, { kind: 'user_prompt', at: T0, promptNumber: 1, promptText: 'hi' })
  const refs: string[] = []
  const credentials = { get: (ref: string) => (refs.push(ref), KEY) }
  for (const response of [() => completion('{"observations":[],"summary":null}'), () => new Response('nope', { status: 402 })]) {
    seedEvent(temp.store, session, { kind: 'turn_end', at: T0 + refs.length + 1, promptNumber: 1 })
    const { fetch, calls } = fakeFetch(response)
    const logs: string[] = []
    await processSessionBatch({ db: temp.store.db, runnerFor: (settings) => createRunner(settings, { dataDir: temp.dataDir, credentials, fetch }), log: (line) => logs.push(line) }, session)
    expect(calls).toHaveLength(1)
    expect(logs.join('\n')).not.toContain(KEY)
  }
  expect(refs).toEqual(['openrouter', 'openrouter'])
  const dump = JSON.stringify(temp.store.db.query('SELECT * FROM observer_runs').all())
  expect(dump).not.toContain(KEY)
  expect(dump).toContain('http_error: openrouter answered 402')
})
