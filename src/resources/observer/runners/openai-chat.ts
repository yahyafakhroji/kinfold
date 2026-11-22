// The OpenAI chat completions shape, which OpenRouter, OpenAI, Gemini's
// compatibility endpoint, DashScope and the OpenAI-compatible servers all
// speak. The request carries no tools, so no tool can run; an answer that asks
// for one anyway is refused as tool_attempt rather than read as text.

import { isRecord } from '../../contract/event'
import { ObserverError, type ObserverPrompt, type ObserverRunner, type RunnerResult } from '../types'
import { DEFAULT_HTTP_TIMEOUT_MS, type FetchFn, postJson } from './http-core'

export interface ChatRunnerOptions {
  label: string
  url: string
  /** Sent as a Bearer token; null sends no Authorization header (a local server). */
  apiKey: string | null
  model: string
  headers?: Record<string, string>
  /** Request fields beyond model and messages, such as temperature or a JSON mode. */
  extraBody?: Record<string, unknown>
  fetch?: FetchFn
  timeoutMs?: number
}

export const defaultFetch: FetchFn = (url, init) => fetch(url, init)

/** Reads choices[0].message.content plus the routed model and token counts. */
export function parseCompletion(value: unknown, configuredModel: string): RunnerResult {
  if (!isRecord(value) || !Array.isArray(value.choices)) throw new ObserverError('bad_response', 'completion has no choices')
  const first: unknown = value.choices[0]
  const message = isRecord(first) && isRecord(first.message) ? first.message : null
  const toolCalls = message !== null && Array.isArray(message.tool_calls) ? message.tool_calls.length : 0
  if (toolCalls > 0) throw new ObserverError('tool_attempt', `the answer asked for ${toolCalls} tool call(s)`)
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

export function createChatRunner(options: ChatRunnerOptions): ObserverRunner {
  const fetchFn = options.fetch ?? defaultFetch
  const headers = { ...(options.apiKey === null ? {} : { authorization: `Bearer ${options.apiKey}` }), ...options.headers }
  const run = async (prompt: ObserverPrompt): Promise<RunnerResult> => {
    const body = {
      model: options.model,
      ...options.extraBody,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    }
    const answer = await postJson({ fetch: fetchFn, url: options.url, headers, body, timeoutMs: options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS, label: options.label })
    return parseCompletion(answer, options.model)
  }
  return { run }
}
