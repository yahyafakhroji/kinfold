import { describe, expect, test } from 'bun:test'
import { runPlantedCheck } from '../planted-check'
import { HTTP_API_PROVIDERS, type HttpApiProvider, ObserverError, type ObserverPrompt } from '../types'
import { ANTHROPIC_ENDPOINT, GEMINI_ENDPOINT, OPENAI_ENDPOINT, createApiRunner, plantedCheckRunner } from './api'
import { MAX_RESPONSE_BYTES } from './http-core'
import type { FetchFn } from './openrouter'

const KEY = 'sk-test-fake-key-000000000000000000000000'
const PROMPT: ObserverPrompt = { system: 'SYSTEM RULES', user: 'EVENTS', eventIds: ['01JA'] }
const MARKER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

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

const chat = (content: string, extra: Record<string, unknown> = {}): Response =>
  Response.json({ model: 'served-model', choices: [{ message: { role: 'assistant', content, ...extra } }], usage: { prompt_tokens: 5, completion_tokens: 7 } })
const anthropic = (blocks: unknown[]): Response =>
  Response.json({ model: 'claude-haiku-5-5-20261001', content: blocks, stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 13 } })
const reply = (provider: HttpApiProvider, text: string): Response => (provider === 'anthropic-api' ? anthropic([{ type: 'text', text }]) : chat(text))

const headers = (call: Call): Record<string, string> => call.init.headers as Record<string, string>
const body = (call: Call): Record<string, unknown> => JSON.parse(call.init.body as string)

const ENDPOINTS: Partial<Record<HttpApiProvider, string>> = {
  'qwen-api': 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  'openai-compatible': 'http://127.0.0.1:11434/v1',
}

function runnerFor(provider: HttpApiProvider, fetch: FetchFn, apiKey: string | null = KEY) {
  const endpoint = ENDPOINTS[provider]
  return createApiRunner(provider, { apiKey, model: 'm1', fetch, ...(endpoint === undefined ? {} : { endpoint }) })
}

describe('each API provider sends one request with the key only in its auth header', () => {
  const cases: [HttpApiProvider, string, (call: Call) => void][] = [
    ['openrouter', 'https://openrouter.ai/api/v1/chat/completions', (call) => {
      expect(headers(call).authorization).toBe(`Bearer ${KEY}`)
      expect(body(call)).toEqual({ model: 'm1', temperature: 0, messages: [{ role: 'system', content: 'SYSTEM RULES' }, { role: 'user', content: 'EVENTS' }] })
    }],
    ['openai-api', OPENAI_ENDPOINT, (call) => {
      expect(headers(call).authorization).toBe(`Bearer ${KEY}`)
      // GPT-6 models reason, and reasoning models refuse a temperature.
      expect(body(call)).toEqual({ model: 'm1', response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'SYSTEM RULES' }, { role: 'user', content: 'EVENTS' }] })
    }],
    ['gemini-api', GEMINI_ENDPOINT, (call) => {
      expect(headers(call).authorization).toBe(`Bearer ${KEY}`)
      // Google asks Gemini 3 callers to keep the default temperature; lower values can loop.
      expect(body(call)).toEqual({ model: 'm1', response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'SYSTEM RULES' }, { role: 'user', content: 'EVENTS' }] })
    }],
    ['qwen-api', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', (call) => {
      expect(headers(call).authorization).toBe(`Bearer ${KEY}`)
      expect(body(call)).toEqual({ model: 'm1', temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'SYSTEM RULES' }, { role: 'user', content: 'EVENTS' }] })
    }],
    ['openai-compatible', 'http://127.0.0.1:11434/v1/chat/completions', (call) => {
      expect(headers(call).authorization).toBe(`Bearer ${KEY}`)
      // No JSON mode: Ollama, LM Studio and the hosted ones each accept a different one, and the prompt already asks for JSON.
      expect(body(call)).toEqual({ model: 'm1', temperature: 0, messages: [{ role: 'system', content: 'SYSTEM RULES' }, { role: 'user', content: 'EVENTS' }] })
    }],
    ['anthropic-api', ANTHROPIC_ENDPOINT, (call) => {
      expect(headers(call)['x-api-key']).toBe(KEY)
      expect(headers(call).authorization).toBeUndefined()
      expect(headers(call)['anthropic-version']).toBe('2023-06-01')
      expect(body(call)).toEqual({ model: 'm1', max_tokens: 8192, system: 'SYSTEM RULES', messages: [{ role: 'user', content: 'EVENTS' }] })
    }],
  ]
  test('every API provider has a case', () => {
    expect(cases.map(([provider]) => provider).sort()).toEqual([...HTTP_API_PROVIDERS].sort())
  })
  for (const [provider, url, check] of cases) {
    test(provider, async () => {
      const { fetch, calls } = fakeFetch(() => reply(provider, '{"observations":[]}'))
      const result = await runnerFor(provider, fetch).run(PROMPT)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toBe(url)
      expect(calls[0]!.init.method).toBe('POST')
      expect(headers(calls[0]!)['content-type']).toBe('application/json')
      expect(JSON.stringify(body(calls[0]!))).not.toContain(KEY)
      check(calls[0]!)
      expect(result.text).toBe('{"observations":[]}')
    })
  }
})

test('the OpenAI-compatible endpoint sends no auth header without a key', async () => {
  const { fetch, calls } = fakeFetch(() => chat('{}'))
  await runnerFor('openai-compatible', fetch, null).run(PROMPT)
  expect(headers(calls[0]!).authorization).toBeUndefined()
})

test.each(['qwen-api', 'openai-compatible'] as const)('%s without an endpoint is a config error before any request', (provider) => {
  const { fetch, calls } = fakeFetch(() => chat('{}'))
  expect(() => createApiRunner(provider, { apiKey: KEY, model: 'm', fetch })).toThrow('config_invalid')
  expect(calls).toHaveLength(0)
})

test.each(['openai-api', 'gemini-api', 'qwen-api', 'anthropic-api', 'openrouter'] as const)('%s without a key is a credential error before any request', (provider) => {
  const { fetch, calls } = fakeFetch(() => chat('{}'))
  expect(() => runnerFor(provider, fetch, null)).toThrow('credential_missing')
  expect(calls).toHaveLength(0)
})

test('usage and the served model are read from each answer shape', async () => {
  const openai = await runnerFor('openai-api', fakeFetch(() => chat('x')).fetch).run(PROMPT)
  expect(openai).toEqual({ text: 'x', model: 'served-model', usage: { inputTokens: 5, outputTokens: 7 } })
  const claude = await runnerFor('anthropic-api', fakeFetch(() => anthropic([{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).fetch).run(PROMPT)
  expect(claude).toEqual({ text: 'ab', model: 'claude-haiku-5-5-20261001', usage: { inputTokens: 11, outputTokens: 13 } })
})

describe('failures are named and never carry the key or the body', () => {
  const failures: [string, HttpApiProvider, () => Response, string][] = [
    ['an HTTP error', 'anthropic-api', () => new Response('{"error":"bad key"}', { status: 401 }), 'http_error: anthropic answered 401'],
    ['an HTTP error', 'gemini-api', () => new Response('nope', { status: 429 }), 'http_error: gemini answered 429'],
    ['an HTTP error', 'openai-compatible', () => new Response('nope', { status: 500 }), 'http_error: openai-compatible answered 500'],
    ['a body that is not JSON', 'qwen-api', () => new Response('<html>'), 'bad_response: qwen body is not JSON'],
    ['a body over the cap', 'openai-api', () => new Response('x'.repeat(MAX_RESPONSE_BYTES + 1)), `bad_response: openai body is larger than ${MAX_RESPONSE_BYTES} bytes`],
    ['no text', 'openai-api', () => Response.json({ choices: [] }), 'bad_response: completion has no message text'],
    ['a tool call in a chat answer', 'openai-compatible', () => chat('', { tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } }] }), 'tool_attempt: the answer asked for 1 tool call(s)'],
    ['a tool call in a Claude answer', 'anthropic-api', () => anthropic([{ type: 'tool_use', id: 't', name: 'read', input: {} }]), 'tool_attempt: the answer asked for 1 tool call(s)'],
    ['a Claude block of an unknown kind', 'anthropic-api', () => anthropic([{ type: 'surprise' }]), 'bad_response: message has a content block of an unknown type'],
    ['a Claude answer with no text', 'anthropic-api', () => anthropic([]), 'bad_response: message has no text'],
  ]
  for (const [what, provider, response, message] of failures) {
    test(`${provider}: ${what}`, async () => {
      let caught: unknown
      try {
        await runnerFor(provider, fakeFetch(response).fetch).run(PROMPT)
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ObserverError)
      expect((caught as Error).message).toBe(message)
      expect((caught as Error).message).not.toContain(KEY)
    })
  }

  test('a network error keeps only the error name, and a timeout is named as one', async () => {
    const network: FetchFn = async () => {
      throw new TypeError(`connect failed with ${KEY}`)
    }
    await expect(runnerFor('anthropic-api', network).run(PROMPT)).rejects.toThrow('http_error: request failed (TypeError)')
    const slow: FetchFn = async () => {
      throw new DOMException('timed out', 'TimeoutError')
    }
    await expect(runnerFor('qwen-api', slow).run(PROMPT)).rejects.toThrow('timeout: request failed (TimeoutError)')
  })
})

describe('every API provider passes the planted-instruction check', () => {
  for (const provider of HTTP_API_PROVIDERS) {
    test(`${provider}: a clean answer passes and the planted file never reaches the request`, async () => {
      const { fetch, calls } = fakeFetch(() => reply(provider, 'Nothing to report.'))
      expect(await runPlantedCheck(plantedCheckRunner(runnerFor(provider, fetch)), () => MARKER)).toEqual({ ok: true })
      expect(calls).toHaveLength(2)
      for (const call of calls) expect(String(call.init.body)).not.toContain(MARKER)
      expect(String(calls[1]!.init.body)).toContain('notes.txt')
    })

    test(`${provider}: an answer that echoes the marker fails`, async () => {
      let n = 0
      const { fetch } = fakeFetch(() => reply(provider, n++ === 0 ? 'OK' : `contents: ${MARKER}`))
      expect(await runPlantedCheck(plantedCheckRunner(runnerFor(provider, fetch)), () => MARKER)).toEqual({ ok: false, errorClass: 'safety_check_failed' })
    })
  }
})
