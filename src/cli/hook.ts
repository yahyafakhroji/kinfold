// Host hook entry: `bun src/cli/hook.ts [--host codex|cursor]` with the hook
// payload on stdin; no --host means Claude Code, which is how every existing
// Claude Code entry calls it. Hosts read a hook's stdout as context and a
// non-zero exit as a problem, so this exits 0 whatever happens and keeps
// stdout empty, with two exceptions. On session start, after capturing the
// event, it prints exactly one JSON object carrying the project's context pack
// (daemon first, read-only fallback second, 300 ms for both) in the shape that
// host reads. On a Claude Code user prompt it prints the prompt-time delta
// (P1-H: memory written since the session last received it) the same way, as
// UserPromptSubmit additionalContext. Any failure or an empty answer prints
// nothing. Errors go to stderr
// without the payload. Under the observer (KINFOLD_OBSERVER=1) it captures and
// injects nothing. host_version comes from the payload when the host sends
// one (Cursor), otherwise from the installer's record (adapters/host-version.ts):
// one file read and one stat, never a `--version` spawn.

import { CLAUDE_CODE_HOST, normalizeClaudeCode, userPromptContextOutput } from '../adapters/claude-code'
import { CODEX_HOST, normalizeCodex } from '../adapters/codex'
import { type AdapterContext, defaultAdapterContext } from '../adapters/context'
import { CURSOR_HOST, normalizeCursor } from '../adapters/cursor'
import { recordedHostVersion } from '../adapters/host-version'
import { type ContextClientOptions, fetchContext } from '../context/client'
import { type ContextChannel, MAX_CONTEXT_PROMPT_CHARS } from '../context/types'
import type { NormalizedEvent } from '../contract/event'
import { isObserverProcess } from '../observer/env'
import { resolveDataDir } from '../store/data-dir'
import { recordEvent } from './record'

export type ErrorSink = (line: string) => void

export type HookHost = typeof CLAUDE_CODE_HOST | typeof CODEX_HOST | typeof CURSOR_HOST

interface HookHostSpec {
  normalize: (payload: unknown, context: AdapterContext) => NormalizedEvent | null
  /** The stdout line that hands `text` to the host as session context. */
  sessionContext: (text: string) => string
  /** The stdout line that adds the prompt-time delta to a turn; absent for hosts not wired for it yet (Cursor). Codex documents the same UserPromptSubmit shape as Claude Code. */
  promptContext?: (text: string) => string
}

/** Claude Code and Codex share the hookSpecificOutput shape; Cursor's sessionStart reads additional_context. */
const hookSpecific = (text: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })

export const HOOK_HOSTS: Readonly<Record<HookHost, HookHostSpec>> = {
  'claude-code': { normalize: normalizeClaudeCode, sessionContext: hookSpecific, promptContext: userPromptContextOutput },
  // Codex documents the same UserPromptSubmit hookSpecificOutput shape as Claude Code (docs/p1f-report.md).
  codex: { normalize: normalizeCodex, sessionContext: hookSpecific, promptContext: userPromptContextOutput },
  cursor: { normalize: normalizeCursor, sessionContext: (text) => JSON.stringify({ additional_context: text }) },
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `--host <id>` or `--host=<id>`; anything else is Claude Code. Unknown ids are null, and nothing is captured. */
export function hostFromArgs(argv: readonly string[]): HookHost | null {
  const at = argv.findIndex((arg) => arg === '--host' || arg.startsWith('--host='))
  const flag = argv[at]
  if (flag === undefined) return CLAUDE_CODE_HOST
  const value = flag.startsWith('--host=') ? flag.slice('--host='.length) : argv[at + 1]
  return value !== undefined && Object.hasOwn(HOOK_HOSTS, value) ? (value as HookHost) : null
}

/** Test seams for the session-start injection; the CLI uses the defaults. */
export type InjectOptions = Pick<ContextClientOptions, 'budgetMs' | 'daemonShareMs' | 'fetch'>

/** Normalizes and spools one payload; null when it is not a JSON hook payload or not an event we capture. */
async function capture(input: string, dataDir: string, host: HookHost, stderr: ErrorSink): Promise<NormalizedEvent | null> {
  let payload: unknown
  try {
    payload = JSON.parse(input)
  } catch {
    stderr('kinfold-hook: stdin is not a JSON hook payload; nothing captured')
    return null
  }
  let event: NormalizedEvent | null = null
  try {
    event = HOOK_HOSTS[host].normalize(payload, defaultAdapterContext(recordedHostVersion(dataDir, host)))
    if (event === null) return null
    const { nudge } = await recordEvent(event, dataDir)
    if (!nudge.ok) stderr(`kinfold-hook: event ${event.eventId} spooled, nudge skipped: ${nudge.reason}`)
  } catch (error: unknown) {
    stderr(`kinfold-hook: nothing captured: ${errorMessage(error)}`)
  }
  return event
}

/** Which context an event asks for, and the line that carries it; null when this event and host get none. */
function contextFor(event: NormalizedEvent, host: HookHost): { channel: ContextChannel; render: (text: string) => string } | null {
  const spec = HOOK_HOSTS[host]
  if (event.kind === 'session_start') return { channel: 'session_start', render: spec.sessionContext }
  if (event.kind === 'user_prompt' && spec.promptContext !== undefined) return { channel: 'prompt', render: spec.promptContext }
  return null
}

/** The one stdout object the host reads as context (the pack, or the prompt delta), or null when there is nothing to add. */
async function contextOutput(event: NormalizedEvent, dataDir: string, host: HookHost, stderr: ErrorSink, inject: InjectOptions): Promise<string | null> {
  const wanted = contextFor(event, host)
  if (wanted === null) return null
  const prompt = wanted.channel === 'prompt' ? (event.promptText ?? '').slice(0, MAX_CONTEXT_PROMPT_CHARS) : ''
  const fetched = await fetchContext(
    dataDir,
    { host: event.host, cwd: event.cwd, hostSessionId: event.hostSessionId, channel: wanted.channel, ...(prompt.trim() !== '' ? { prompt } : {}) },
    { ...inject, log: (line) => stderr(`kinfold-hook: ${line}`) },
  )
  if (fetched.result === null || fetched.result.text === '') return null
  return wanted.render(fetched.result.text)
}

/**
 * Captures the event; on session start (and, for Claude Code, on each user
 * prompt) returns the context line for stdout. Never throws; null means
 * stdout stays empty.
 */
export async function runHook(
  input: string,
  dataDir: string,
  stderr: ErrorSink,
  env: Readonly<Record<string, string | undefined>> = process.env,
  inject: InjectOptions = {},
  host: HookHost = CLAUDE_CODE_HOST,
): Promise<string | null> {
  if (isObserverProcess(env)) return null
  const event = await capture(input, dataDir, host, stderr)
  if (event === null) return null
  try {
    return await contextOutput(event, dataDir, host, stderr, inject)
  } catch (error: unknown) {
    stderr(`kinfold-hook: no context injected: ${errorMessage(error)}`)
    return null
  }
}

async function main(): Promise<void> {
  const stderr: ErrorSink = (line) => {
    process.stderr.write(`${line}\n`)
  }
  if (isObserverProcess()) process.exit(0)
  try {
    const host = hostFromArgs(process.argv.slice(2))
    if (host === null) {
      stderr('kinfold-hook: unknown --host; nothing captured')
    } else {
      const output = await runHook(await Bun.stdin.text(), resolveDataDir(), stderr, process.env, {}, host)
      if (output !== null) process.stdout.write(`${output}\n`)
    }
  } catch (error: unknown) {
    stderr(`kinfold-hook: ${errorMessage(error)}`)
  }
  process.exit(0)
}

if (import.meta.main) await main()
