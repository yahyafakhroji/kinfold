// Host hook entry: `bun src/cli/hook.ts [--host codex|cursor]` with the hook
// payload on stdin; no --host means Claude Code, which is how every existing
// Claude Code entry calls it. Hosts read a hook's stdout as context and a
// non-zero exit as a problem, so this exits 0 whatever happens and keeps
// stdout empty, with two exceptions. On session start, after capturing the
// event, it prints exactly one JSON object carrying the project's context pack
// (daemon first, read-only fallback second, 300 ms for both) in the shape that
// host reads; a compiled program has no SQLite, so it asks the daemon only and
// prints nothing while the daemon is down. On a user prompt it prints the
// prompt-time delta (memory written since the session last received it) the
// same way, for every agent whose spec takes it; an agent that drops one of
// the two gets nothing then. Any failure or an empty answer prints nothing.
// Errors go to stderr without the payload. Under the observer (KINFOLD_OBSERVER=1) it captures and
// injects nothing. host_version comes from the payload when the host sends
// one (Cursor), otherwise from the installer's record (adapters/host-version.ts):
// one file read and one stat, never a `--version` spawn.

import { CLAUDE_CODE_HOST } from '../adapters/claude-code'
import { defaultAdapterContext } from '../adapters/context'
import { recordedHostVersion } from '../adapters/host-version'
import { HOOK_SPECS, hookSpecFor } from '../agents/hook-specs'
import type { AgentId } from '../agents/profile'
import { type ContextClientOptions, fetchContext } from '../context/client'
import { type ContextChannel, MAX_CONTEXT_PROMPT_CHARS, type UpdateNotice } from '../context/types'
import type { NormalizedEvent } from '../contract/event'
import { isObserverProcess } from '../observer/env'
import { resolveDataDir } from '../store/data-dir'
import { applyDataDirFlag } from '../store/data-dir-flag'
import { recordEvent } from './record'

export type ErrorSink = (line: string) => void

export type HookHost = AgentId

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `--host <id>` or `--host=<id>`; anything else is Claude Code. Unknown ids are null, and nothing is captured. */
export function hostFromArgs(argv: readonly string[]): HookHost | null {
  const at = argv.findIndex((arg) => arg === '--host' || arg.startsWith('--host='))
  const flag = argv[at]
  if (flag === undefined) return CLAUDE_CODE_HOST
  const value = flag.startsWith('--host=') ? flag.slice('--host='.length) : argv[at + 1]
  if (value === undefined || !Object.hasOwn(HOOK_SPECS, value)) return null
  return hookSpecFor(value as AgentId) === null ? null : (value as AgentId)
}

/** Test seams for the session-start injection; the CLI uses the defaults. */
export type InjectOptions = Pick<ContextClientOptions, 'budgetMs' | 'daemonShareMs' | 'fetch' | 'fallback'>

/** Normalizes and spools one payload; null when it is not a JSON hook payload or not an event we capture. */
async function capture(input: string, dataDir: string, host: HookHost, stderr: ErrorSink, env: Readonly<Record<string, string | undefined>>): Promise<NormalizedEvent | null> {
  let payload: unknown
  try {
    payload = JSON.parse(input)
  } catch {
    stderr('kinfold-hook: stdin is not a JSON hook payload; nothing captured')
    return null
  }
  const spec = hookSpecFor(host)
  if (spec === null) return null
  let event: NormalizedEvent | null = null
  try {
    // An agent running this host's hooks gets its own label and version; the context line stays in this host's shape, which that agent reads.
    const caller = spec.callerOf?.(payload, env) ?? null
    const normalized = spec.normalize(payload, defaultAdapterContext(recordedHostVersion(dataDir, caller ?? host)))
    if (normalized === null) return null
    event = caller === null ? normalized : { ...normalized, host: caller }
    const { nudge } = await recordEvent(event, dataDir)
    if (!nudge.ok) stderr(`kinfold-hook: event ${event.eventId} spooled, nudge skipped: ${nudge.reason}`)
  } catch (error: unknown) {
    stderr(`kinfold-hook: nothing captured: ${errorMessage(error)}`)
  }
  return event
}

/** Which context an event asks for, and the line that carries it; null when this event and host get none. */
function contextFor(event: NormalizedEvent, host: HookHost): { channel: ContextChannel; render: (text: string) => string } | null {
  const spec = hookSpecFor(host)
  if (spec === null) return null
  if (event.kind === 'session_start') return spec.sessionContextIgnored === true ? null : { channel: 'session_start', render: spec.sessionContext }
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
  const result = fetched.result
  if (result === null) return null
  // The notice rides on session start only; the route never attaches it to a prompt delta.
  if (wanted.channel === 'session_start' && result.updateNotice !== undefined) return hookSpecFor(host)?.sessionContextWithNotice(result.text, result.updateNotice) ?? null
  return result.text === '' ? null : wanted.render(result.text)
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
  const event = await capture(input, dataDir, host, stderr, env)
  if (event === null) return null
  try {
    return await contextOutput(event, dataDir, host, stderr, inject)
  } catch (error: unknown) {
    stderr(`kinfold-hook: no context injected: ${errorMessage(error)}`)
    return null
  }
}

/** The hook entry when `kinfold hook` runs it; `argv` is what follows the subcommand. Never throws, so the host sees exit 0. */
export async function runHookCli(argv: readonly string[]): Promise<void> {
  const stderr: ErrorSink = (line) => {
    process.stderr.write(`${line}\n`)
  }
  if (isObserverProcess()) return
  try {
    const host = hostFromArgs(applyDataDirFlag(argv))
    if (host === null) {
      stderr('kinfold-hook: unknown --host; nothing captured')
    } else {
      const output = await runHook(await Bun.stdin.text(), resolveDataDir(), stderr, process.env, {}, host)
      if (output !== null) process.stdout.write(`${output}\n`)
    }
  } catch (error: unknown) {
    stderr(`kinfold-hook: ${errorMessage(error)}`)
  }
}

async function main(): Promise<void> {
  await runHookCli(process.argv.slice(2))
  process.exit(0)
}

if (import.meta.main) await main()
