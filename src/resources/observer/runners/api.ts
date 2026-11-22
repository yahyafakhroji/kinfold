// Builds the runner for an API provider from a key the caller read from the
// key store. Nothing here reads a store or the network until run().

import type { CliObserverRunner } from './cli-core'
import { ObserverError, type HttpApiProvider, type ObserverRunner } from '../types'
import { ANTHROPIC_ENDPOINT, createAnthropicRunner } from './anthropic'
import type { FetchFn } from './http-core'
import { createChatRunner } from './openai-chat'
import { createOpenRouterRunner } from './openrouter'

export { ANTHROPIC_ENDPOINT }
export const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions'
export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'

const JSON_OBJECT = { response_format: { type: 'json_object' } } as const

export interface ApiRunnerOptions {
  /** null only for a keyless OpenAI-compatible endpoint; every other provider needs one. */
  apiKey: string | null
  model: string
  endpoint?: string
  fetch?: FetchFn
  timeoutMs?: number
}

function requireKey(provider: HttpApiProvider, apiKey: string | null): string {
  if (apiKey === null) throw new ObserverError('credential_missing', `${provider} needs a key`)
  return apiKey
}

function requireEndpoint(provider: HttpApiProvider, endpoint: string | undefined): string {
  if (endpoint === undefined) throw new ObserverError('config_invalid', `${provider} needs an endpoint`)
  return `${endpoint}/chat/completions`
}

export function createApiRunner(provider: HttpApiProvider, options: ApiRunnerOptions): ObserverRunner {
  const common = {
    model: options.model,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  }
  switch (provider) {
    case 'openrouter':
      return createOpenRouterRunner({ ...common, apiKey: requireKey(provider, options.apiKey) })
    case 'anthropic-api':
      return createAnthropicRunner({ ...common, apiKey: requireKey(provider, options.apiKey) })
    case 'openai-api':
      // GPT-6 models reason, and reasoning models refuse any temperature but the default.
      return createChatRunner({ ...common, label: 'openai', url: OPENAI_ENDPOINT, apiKey: requireKey(provider, options.apiKey), extraBody: { ...JSON_OBJECT } })
    case 'gemini-api':
      // Google asks Gemini 3 callers to keep the default temperature: lower values can loop or degrade.
      return createChatRunner({ ...common, label: 'gemini', url: GEMINI_ENDPOINT, apiKey: requireKey(provider, options.apiKey), extraBody: { ...JSON_OBJECT } })
    case 'qwen-api':
      return createChatRunner({ ...common, label: 'qwen', url: requireEndpoint(provider, options.endpoint), apiKey: requireKey(provider, options.apiKey), extraBody: { temperature: 0, ...JSON_OBJECT } })
    case 'openai-compatible':
      // No JSON mode: Ollama takes json_object, LM Studio only json_schema, and the prompt already asks for JSON.
      return createChatRunner({ ...common, label: 'openai-compatible', url: requireEndpoint(provider, options.endpoint), apiKey: options.apiKey, extraBody: { temperature: 0 } })
  }
}

/**
 * An API runner in the shape the planted-instruction check takes. An API
 * observer has no folder to read, so the planted files are never sent; the
 * check still proves that a reply is read as text and that the marker cannot
 * reach the model.
 */
export function plantedCheckRunner(runner: ObserverRunner): CliObserverRunner {
  return {
    run: (prompt) => runner.run(prompt),
    runWithFiles: (prompt) => runner.run(prompt),
    probe: async () => ({ version: 'api', binaryPath: 'api' }),
    listModels: async () => [],
  }
}
