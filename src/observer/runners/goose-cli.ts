// Observer through the user's own `goose` CLI and the provider keys it keeps
// in the system keyring. Checked live against goose 1.59.2 (2026-11-16) and
// its source:
//   - `goose run -i - -q --no-session --no-profile --output-format json`
//     reads the prompt on stdin, loads none of the user's extensions, saves
//     no session and prints one JSON object.
//   - GOOSE_PATH_ROOT moves goose's config, data, state and plugin folders.
//     It points inside the run folder, which is removed after every run: the
//     state folder logs every model request, prompt included, and plugins
//     hold hooks.
//   - GOOSE_MODE=chat: goose still offers its built-in load_skill tool, but
//     in chat mode answers any call to it with a fixed "skipped" text and
//     never runs it (crates/goose/src/agents/state_machine/ops_skills.rs). A
//     tool request in the output still rejects the run.
// The model names a goose provider: `<provider>/<model>`. Only providers that
// call a model over HTTP are allowed; one that wraps another agent's CLI
// (claude-code, codex, gemini-cli, cursor-agent, the ACP ones) would run that
// agent's tools where goose's output cannot show them.

import { join } from 'node:path'
import { isRecord } from '../../contract/event'
import type { Parsed } from '../../context/types'
import { checkEndpoint } from '../endpoint'
import { ObserverError } from '../types'
import { type CliAdapter, type CliParsed, type Semver, parseSemver } from './cli-core'

export const GOOSE_MIN_VERSION: Semver = [1, 59, 0]

/** Goose providers whose key lives in the keyring (or, for ollama, none is needed), so they work with the config folder moved. */
export const GOOSE_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'xai', 'ollama', 'tetrate'] as const

const ROOT_DIR = 'goose'
/** The only tool goose offers with every extension off; chat mode skips it. */
const BUILT_IN_TOOLS: ReadonlySet<string> = new Set(['load_skill'])
const SILENT_TYPES: ReadonlySet<string> = new Set(['thinking', 'redactedThinking', 'reasoning'])
const TOOL_TYPE = /tool|action/i
/** The whole --version answer is the version; the database tool of the same name says "goose version: v3…". */
const VERSION_PATTERN = /^\s*v?(\d+)\.(\d+)\.(\d+)\s*$/
const MODEL_PART = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/

export interface GooseModel {
  provider: string
  model: string
}

const MODEL_ERROR = `goose-cli models are <provider>/<model>, provider one of ${GOOSE_PROVIDERS.join(', ')}`

/** The error never quotes the model: it is user text that reaches argv. */
export function parseGooseModel(value: string): Parsed<GooseModel> {
  const at = value.indexOf('/')
  const provider = at <= 0 ? '' : value.slice(0, at)
  const model = at <= 0 ? '' : value.slice(at + 1)
  if (!(GOOSE_PROVIDERS as readonly string[]).includes(provider) || !MODEL_PART.test(model)) return { ok: false, error: MODEL_ERROR }
  return { ok: true, value: { provider, model } }
}

function isolatedEnv(runDir: string, baseEnv: Record<string, string>): Record<string, string> {
  return { ...baseEnv, GOOSE_PATH_ROOT: join(runDir, ROOT_DIR), GOOSE_MODE: 'chat', GOOSE_TELEMETRY_ENABLED: 'false' }
}

function contentItems(message: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(message.content)) throw new ObserverError('bad_response', 'goose output has a message with no content')
  return message.content.map((item) => {
    if (!isRecord(item) || typeof item.type !== 'string') throw new ObserverError('bad_response', 'goose output has a content item of an unknown type')
    return item
  })
}

/** Tools the model was offered beyond the built-in one, each an extension that should not have loaded; null when the message does not say. */
function extraAdvertised(message: Record<string, unknown>): number | null {
  const llm = isRecord(message.metadata) && isRecord(message.metadata.operations) && isRecord(message.metadata.operations.llm) ? message.metadata.operations.llm : null
  if (llm === null || !Array.isArray(llm.advertised_tools)) return null
  return llm.advertised_tools.filter((name) => typeof name !== 'string' || !BUILT_IN_TOOLS.has(name)).length
}

/** Ollama's address as goose reads it, with or without a scheme. Session text must not cross a network in plain http. */
function ollamaHostProblem(host: string | undefined): string | null {
  if (host === undefined) return null
  const url = /^[a-z]+:\/\//i.test(host) ? host : `http://${host}`
  return checkEndpoint('openai-compatible', url).ok ? null : 'OLLAMA_HOST must use https unless it is on this machine'
}

function parse(stdout: string): CliParsed {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new ObserverError('bad_response', 'goose output is not JSON')
  }
  if (!isRecord(value) || !Array.isArray(value.messages)) throw new ObserverError('bad_response', 'goose output has no messages')
  const metadata = isRecord(value.metadata) ? value.metadata : {}
  let toolEvents = 0
  let unknown = false
  // The offered tools are the check that no extension loaded, so a turn that does not list them cannot be trusted.
  let unlisted = false
  const texts: string[] = []
  for (const message of value.messages) {
    if (!isRecord(message)) throw new ObserverError('bad_response', 'goose output has a message that is not an object')
    const extra = extraAdvertised(message)
    if (extra === null) unlisted ||= message.role === 'assistant'
    else toolEvents += extra
    for (const item of contentItems(message)) {
      const type = item.type as string
      if (TOOL_TYPE.test(type)) toolEvents += 1
      else if (type === 'text' && typeof item.text === 'string') {
        if (message.role === 'assistant') texts.push(item.text)
      } else if (!SILENT_TYPES.has(type)) unknown = true
    }
  }
  // Tool events are counted first, so the core can report tool_attempt for output it otherwise refuses.
  const parsed: CliParsed = {
    text: texts.join(''),
    model: null,
    toolEvents,
    sessionId: null,
    usage: {
      ...(typeof metadata.input_tokens === 'number' ? { inputTokens: metadata.input_tokens } : {}),
      ...(typeof metadata.output_tokens === 'number' ? { outputTokens: metadata.output_tokens } : {}),
    },
  }
  if (toolEvents > 0) return parsed
  if (unknown) throw new ObserverError('bad_response', 'goose output has a content item of an unknown type')
  if (unlisted) throw new ObserverError('bad_response', 'goose output does not say which tools the model was offered')
  if (metadata.status !== 'completed') throw new ObserverError('bad_response', 'goose run did not complete')
  if (texts.length === 0) throw new ObserverError('bad_response', 'goose output has no assistant text')
  return parsed
}

export const gooseAdapter: CliAdapter = {
  provider: 'goose-cli',
  binary: 'goose',
  // The keyring needs the D-Bus session on Linux; OLLAMA_HOST is how goose finds a local Ollama with its config folder moved.
  extraEnv: ['OLLAMA_HOST', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'],
  minVersion: GOOSE_MIN_VERSION,
  parseVersion: (stdout) => parseSemver(VERSION_PATTERN, stdout),
  isolatedEnv,
  probeInRunDir: true,
  invocation: ({ binaryPath, runDir, model, system, env }) => {
    const parsed = parseGooseModel(model)
    if (!parsed.ok) throw new ObserverError('config_invalid', parsed.error)
    const hostProblem = parsed.value.provider === 'ollama' ? ollamaHostProblem(env.OLLAMA_HOST) : null
    if (hostProblem !== null) throw new ObserverError('config_invalid', hostProblem)
    return {
      cmd: [
        binaryPath, 'run', '-i', '-', '-q', '--no-session', '--no-profile', '--output-format', 'json',
        '--provider', parsed.value.provider, '--model', parsed.value.model, '--system', system,
      ],
      env: isolatedEnv(runDir, env),
      files: [],
    }
  },
  parse,
  listModels: async () => [],
}
