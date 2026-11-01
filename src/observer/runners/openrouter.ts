// Observer through OpenRouter's OpenAI-compatible chat API (default for
// OpenCode sessions: the Auto Router, openrouter/auto). The key is passed in by
// the caller from the keychain and only ever goes into the Authorization
// header; errors carry an HTTP status or an error name, never the body.

import { isRecord } from '../../contract/event'
import { ObserverError, type ObserverPrompt, type ObserverRunner, type RunnerResult } from '../types'

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
export const DEFAULT_HTTP_TIMEOUT_MS = 120_000

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export interface OpenRouterOptions {
  apiKey: string
  model: string
  fetch?: FetchFn
  timeoutMs?: number
}

function requestBody(model: string, prompt: ObserverPrompt): string {
  return JSON.stringify({
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
  })
}

/** Reads choices[0].message.content plus the routed model and token counts. */
export function parseCompletion(value: unknown, configuredModel: string): RunnerResult {
  if (!isRecord(value) || !Array.isArray(value.choices)) throw new ObserverError('bad_response', 'completion has no choices')
  const first: unknown = value.choices[0]
  const message = isRecord(first) && isRecord(first.message) ? first.message : null
  if (message === null || typeof message.content !== 'string') throw new ObserverError('bad_response', 'completion has no message text')
  const usage = isRecord(value.usage) ? value.usage : {}
  return {
    text: message.content,
    model: typeof value.model === 'string' && value.model !== '' ? value.model : configuredModel,
    usage: {
      ...(typeof usage.prompt_tokens === 'number' ? { inputTokens: usage.prompt_tokens } : {}),
      ...(typeof usage.completion_tokens === 'number' ? { outputTokens: usage.completion_tokens } : {}),
    },
  }
}

async function post(fetchFn: FetchFn, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(OPENROUTER_ENDPOINT, init)
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : 'unknown error'
    throw new ObserverError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'http_error', `request failed (${name})`)
  }
}

export function createOpenRouterRunner(options: OpenRouterOptions): ObserverRunner {
  const fetchFn = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))

  const run = async (prompt: ObserverPrompt): Promise<RunnerResult> => {
    const response = await post(fetchFn, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
        'x-title': 'shared-agent-memory',
      },
      body: requestBody(options.model, prompt),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS),
    })
    if (!response.ok) throw new ObserverError('http_error', `openrouter answered ${response.status}`)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new ObserverError('bad_response', 'openrouter body is not JSON')
    }
    return parseCompletion(body, options.model)
  }
  return { run }
}
