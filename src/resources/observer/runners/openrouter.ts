// Observer through OpenRouter's OpenAI-compatible chat API (default for
// OpenCode sessions: the Auto Router, openrouter/auto). The key is passed in by
// the caller from the keychain and only ever goes into the Authorization
// header; errors carry an HTTP status or an error name, never the body.

import { CLI_NAME } from '../../names'
import type { ObserverRunner } from '../types'
import { DEFAULT_HTTP_TIMEOUT_MS, type FetchFn } from './http-core'
import { createChatRunner } from './openai-chat'

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
export { DEFAULT_HTTP_TIMEOUT_MS, type FetchFn }
export { parseCompletion } from './openai-chat'

export interface OpenRouterOptions {
  apiKey: string
  model: string
  fetch?: FetchFn
  timeoutMs?: number
}

export function createOpenRouterRunner(options: OpenRouterOptions): ObserverRunner {
  return createChatRunner({
    label: 'openrouter',
    url: OPENROUTER_ENDPOINT,
    apiKey: options.apiKey,
    model: options.model,
    headers: { 'x-title': CLI_NAME },
    extraBody: { temperature: 0 },
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  })
}
