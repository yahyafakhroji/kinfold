// Observer through the Anthropic Messages API with the user's own key. The
// request carries no tools; a tool_use block in the answer is refused as
// tool_attempt, and any block other than text or thinking is unreadable.

import { isRecord } from '../../../system/contract/event'
import { ObserverError, type ObserverPrompt, type ObserverRunner, type RunnerResult } from '../types'
import { DEFAULT_HTTP_TIMEOUT_MS, type FetchFn, postJson } from './http-core'
import { defaultFetch } from './openai-chat'

export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages'
export const ANTHROPIC_VERSION = '2023-06-01'
/** Room for the largest answer the parser accepts; the API requires a cap. */
export const ANTHROPIC_MAX_TOKENS = 8192

const SILENT_BLOCKS: ReadonlySet<string> = new Set(['thinking', 'redacted_thinking'])
const TOOL_BLOCKS: ReadonlySet<string> = new Set(['tool_use', 'server_tool_use', 'mcp_tool_use'])

export interface AnthropicOptions {
  apiKey: string
  model: string
  fetch?: FetchFn
  timeoutMs?: number
}

export function parseMessage(value: unknown, configuredModel: string): RunnerResult {
  if (!isRecord(value) || !Array.isArray(value.content)) throw new ObserverError('bad_response', 'message has no content')
  const blocks = value.content.map((block) => (isRecord(block) && typeof block.type === 'string' ? block : null))
  const tools = blocks.filter((block) => block !== null && TOOL_BLOCKS.has(block.type as string)).length
  if (tools > 0) throw new ObserverError('tool_attempt', `the answer asked for ${tools} tool call(s)`)
  const texts: string[] = []
  for (const block of blocks) {
    if (block !== null && block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block === null || !SILENT_BLOCKS.has(block.type as string)) throw new ObserverError('bad_response', 'message has a content block of an unknown type')
  }
  if (texts.length === 0) throw new ObserverError('bad_response', 'message has no text')
  const usage = isRecord(value.usage) ? value.usage : {}
  return {
    text: texts.join(''),
    model: typeof value.model === 'string' && value.model !== '' ? value.model : configuredModel,
    usage: {
      ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
      ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
    },
  }
}

export function createAnthropicRunner(options: AnthropicOptions): ObserverRunner {
  const fetchFn = options.fetch ?? defaultFetch
  const run = async (prompt: ObserverPrompt): Promise<RunnerResult> => {
    const answer = await postJson({
      fetch: fetchFn,
      url: ANTHROPIC_ENDPOINT,
      headers: { 'x-api-key': options.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: { model: options.model, max_tokens: ANTHROPIC_MAX_TOKENS, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] },
      timeoutMs: options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
      label: 'anthropic',
    })
    return parseMessage(answer, options.model)
  }
  return { run }
}
