// Observer through the user's own `codex` CLI and ChatGPT login. The run is
// `codex exec` with every tool we know of turned off, no user config, rules or
// project layer, no saved session, a read-only sandbox, and a private run
// folder as its cwd. The system prompt reaches codex as a planted file; the
// untrusted session text goes on stdin only. The read-only sandbox still lets
// the model read files, which is why the shell tool must be off and why any
// tool-shaped event in the output rejects the run.
// Flags and event names were checked against codex 0.166 docs and source.

import { isRecord } from '../../contract/event'
import { ObserverError, type RunnerUsage } from '../types'
import type { CliAdapter, CliParsed, CliRunContext, Semver } from './cli-core'
import type { SpawnResult } from './claude-cli'

export const CODEX_MIN_VERSION: Semver = [0, 166, 0]

const INSTRUCTIONS_FILE = 'instructions.md'
const LIST_MODELS_TIMEOUT_MS = 30_000
const VERSION_PATTERN = /\bcodex-cli\s+(\d+)\.(\d+)\.(\d+)/

/** Each becomes a `-c` pair. `--strict-config` makes codex fail on any key it does not know. */
const CONFIG_OVERRIDES = [
  'web_search="disabled"',
  'features.shell_tool=false',
  'features.view_image=false',
  'features.apply_patch_freeform=false',
  'features.plugins=false',
  'features.apps=false',
  'features.hooks=false',
  'features.multi_agent=false',
  'features.code_mode=false',
  'features.memories=false',
  'features.goals=false',
] as const

/** Item types that are only model output. Every other item type is a tool. */
const TEXT_ITEM_TYPES: ReadonlySet<string> = new Set(['agent_message', 'reasoning'])
const ITEM_EVENT_TYPES: ReadonlySet<string> = new Set(['item.started', 'item.updated', 'item.completed'])
/** Top-level types that are not tools. Any other type counts as a tool event. */
const LIFECYCLE_TYPES: ReadonlySet<string> = new Set(['thread.started', 'turn.started', 'turn.completed', ...ITEM_EVENT_TYPES])
const FAILURE_TYPES: ReadonlySet<string> = new Set(['turn.failed', 'error'])

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const SHORT_ESCAPES: Readonly<Record<string, string>> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' }

/** A TOML basic string. Throws (without quoting the value) when it is not well-formed Unicode. */
export function tomlBasicString(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new ObserverError('internal', 'run folder path is not well-formed Unicode')
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0)!
    const short = SHORT_ESCAPES[char]
    if (short !== undefined) out += short
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`
    else out += char
  }
  return `${out}"`
}

function parseVersion(stdout: string): Semver | null {
  const match = VERSION_PATTERN.exec(stdout)
  if (match === null) return null
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  return parts.every(Number.isSafeInteger) ? parts : null
}

function isolatedEnv(_runDir: string, baseEnv: Record<string, string>): Record<string, string> {
  // CODEX_HOME arrives through extraEnv; --ignore-user-config keeps its config.toml out.
  return baseEnv
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function usageOf(event: Record<string, unknown>): RunnerUsage | undefined {
  if (!isRecord(event.usage)) return undefined
  const inputTokens = tokenCount(event.usage.input_tokens)
  const outputTokens = tokenCount(event.usage.output_tokens)
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) }
}

interface Scan {
  text: string | null
  sessionId: string | null
  usage: RunnerUsage | undefined
  toolEvents: number
  malformedLines: number
  failure: 'turn.failed' | 'error' | null
}

function scanEvents(stdout: string): Scan {
  const scan: Scan = { text: null, sessionId: null, usage: undefined, toolEvents: 0, malformedLines: 0, failure: null }
  const seenToolIds = new Set<string>()
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      scan.malformedLines += 1
      continue
    }
    if (!isRecord(event)) {
      scan.malformedLines += 1
      continue
    }
    const type = event.type
    if (typeof type !== 'string' || !(LIFECYCLE_TYPES.has(type) || FAILURE_TYPES.has(type))) {
      scan.toolEvents += 1
      continue
    }
    if (FAILURE_TYPES.has(type)) {
      scan.failure ??= type as 'turn.failed' | 'error'
    } else if (type === 'thread.started') {
      if (typeof event.thread_id === 'string') scan.sessionId = event.thread_id
    } else if (type === 'turn.completed') {
      scan.usage = usageOf(event)
    } else if (ITEM_EVENT_TYPES.has(type)) {
      const item = isRecord(event.item) ? event.item : null
      const itemType = item !== null && typeof item.type === 'string' ? item.type : null
      if (itemType === null || !TEXT_ITEM_TYPES.has(itemType)) {
        // Counted once per item id: started and completed are the same call.
        const id = item !== null && typeof item.id === 'string' ? item.id : null
        if (id === null || !seenToolIds.has(id)) scan.toolEvents += 1
        if (id !== null) seenToolIds.add(id)
      } else if (itemType === 'agent_message' && type === 'item.completed' && typeof item!.text === 'string') {
        scan.text = item!.text
      }
    }
  }
  return scan
}

/**
 * Tool events win over every other finding, so a failed or garbled run still
 * reports them to the core. Details are fixed strings and counts only.
 */
function parse(stdout: string): CliParsed {
  const scan = scanEvents(stdout)
  const base = { model: null, sessionId: scan.sessionId, ...(scan.usage !== undefined ? { usage: scan.usage } : {}) }
  if (scan.toolEvents > 0) return { ...base, text: scan.text ?? '', toolEvents: scan.toolEvents }
  if (scan.malformedLines > 0) throw new ObserverError('bad_response', `codex output had ${scan.malformedLines} line(s) that are not JSON objects`)
  if (scan.failure === 'turn.failed') throw new ObserverError('bad_response', 'codex reported a failed turn')
  if (scan.failure === 'error') throw new ObserverError('bad_response', 'codex reported an error')
  if (scan.text === null) throw new ObserverError('bad_response', 'codex output has no agent message')
  return { ...base, text: scan.text, toolEvents: 0 }
}

function modelSlugs(stdout: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new ObserverError('bad_response', 'codex debug models output is not JSON')
  }
  const entries = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.models) ? value.models : null
  if (entries === null) throw new ObserverError('bad_response', 'codex debug models output has no model list')
  const slugs = new Set<string>()
  for (const entry of entries) {
    if (isRecord(entry) && typeof entry.slug === 'string' && entry.slug !== '') slugs.add(entry.slug)
  }
  if (slugs.size === 0) throw new ObserverError('bad_response', 'codex debug models output names no model')
  return [...slugs]
}

async function listModels(ctx: Omit<CliRunContext, 'title' | 'sessionId'>): Promise<string[]> {
  const label = 'codex debug models'
  let result: SpawnResult
  try {
    result = await ctx.spawn({ cmd: [ctx.binaryPath, 'debug', 'models', '--bundled'], cwd: ctx.runDir, env: ctx.env, stdin: '', timeoutMs: LIST_MODELS_TIMEOUT_MS })
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'spawn failed'
    throw new ObserverError(code === 'ENOENT' ? 'cli_missing' : 'internal', `${label} could not start (${code})`)
  }
  if (result.timedOut) throw new ObserverError('timeout', `${label} did not finish in ${LIST_MODELS_TIMEOUT_MS} ms`)
  if (result.exitCode !== 0) throw new ObserverError('exit_nonzero', `exited ${result.exitCode}`)
  return modelSlugs(result.stdout)
}

export const codexAdapter: CliAdapter = {
  provider: 'codex-cli',
  binary: 'codex',
  extraEnv: ['CODEX_HOME'],
  minVersion: CODEX_MIN_VERSION,
  parseVersion,
  isolatedEnv,
  invocation: ({ binaryPath, runDir, model, system, env }) => ({
    cmd: [
      binaryPath, 'exec',
      '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--strict-config',
      '-C', runDir,
      '-s', 'read-only',
      '-m', model,
      '--json',
      '--color', 'never',
      ...CONFIG_OVERRIDES.flatMap((override) => ['-c', override]),
      '-c', `model_instructions_file=${tomlBasicString(`${runDir}/${INSTRUCTIONS_FILE}`)}`,
      '-',
    ],
    env: codexAdapter.isolatedEnv(runDir, env),
    files: [{ name: INSTRUCTIONS_FILE, content: system }],
  }),
  parse,
  listModels,
}
