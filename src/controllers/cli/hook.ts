// Host hook entry: `bun src/controllers/cli/hook.ts [--host codex|cursor]` with the hook
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

import { CLAUDE_CODE_HOST } from '../../plugins/adapters/claude-code'
import { defaultAdapterContext } from '../../plugins/adapters/context'
import { recordedHostVersion } from '../../plugins/adapters/host-version'
import { HOOK_SPECS, hookSpecFor } from '../../plugins/agents/hook-specs'
import type { AgentId } from '../../plugins/agents/profile'
import type { HookHostSpec } from '../../plugins/agents/hook-spec'
import { type ContextClientOptions, type ContextFetch, fetchContext } from '../../resources/context/client'
import { readDisplayFile } from '../../resources/context/display-file'
import {
  DAEMON_DOWN_LINE, DAEMON_DOWN_START_LINE, HELD_OUT_LINE, NO_ANSWER_LINE, NO_ANSWER_START_LINE, NO_PROMPT_MEMORY_LINE,
  cleanTitle, daemonDownWith, firstScreenLine, firstScreenList, recallLine,
} from '../../resources/context/recall-line'
import { promptForRecall } from '../../resources/context/prompt-text'
import { type ContextChannel, MAX_CONTEXT_PROMPT_CHARS } from '../../resources/context/types'
import { userMessage as noticeMessage } from '../update/notice-text'
import type { NormalizedEvent } from '../../system/contract/event'
import { isObserverProcess } from '../../resources/observer/env'
import { resolveDataDir } from '../../resources/store/data-dir'
import { applyDataDirFlag } from '../../resources/store/data-dir-flag'
import { recordEvent } from './record'
import { errorMessage } from '../../system/errors'

export type ErrorSink = (line: string) => void

export type HookHost = AgentId

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

/**
 * What the user reads about one answer. It is built from the answer the hook
 * is about to print and from nothing else: the ids are the ones in the context
 * line (none when no context is printed), so the line cannot name a memory the
 * model was not sent, and it costs no second request.
 */
function recallMessage(channel: ContextChannel, fetched: ContextFetch, takesPack: boolean, oneLine = false): string {
  const result = fetched.result
  const start = channel === 'session_start'
  if (result === null) {
    if (fetched.daemonDown) return start ? DAEMON_DOWN_START_LINE : DAEMON_DOWN_LINE
    return start ? NO_ANSWER_START_LINE : NO_ANSWER_LINE
  }
  if (result.display?.unavailable !== undefined) return result.display.unavailable
  if (result.display?.heldOut === true) return HELD_OUT_LINE
  const ids = result.text === '' ? [] : result.observationIds
  const screen = result.display?.firstScreen ?? null
  const line = !start ? recallLine(ids, result.display?.recalled ?? []) : oneLine ? firstScreenLine(screen, ids) : firstScreenList(screen, ids, Date.now(), { takesPack })
  // The stored copy is also read after a daemon that was only slow; "not running" is said only when nothing was listening.
  return fetched.source === 'fallback' && fetched.daemonDown ? daemonDownWith(line) : line
}

/** The one stdout line: the context for the model, the message for the user, both in one object, or null for neither. */
function printed(spec: HookHostSpec, context: string | null, message: string | null): string | null {
  if (message === null || spec.userMessage === undefined) return context
  return spec.userMessage(context, message)
}

/**
 * The one stdout object the host reads: the context for the model (the pack,
 * or the prompt delta) and, for an agent with a user channel, what Kinfold
 * recalled. Null when there is neither.
 */
async function contextOutput(event: NormalizedEvent, dataDir: string, host: HookHost, stderr: ErrorSink, inject: InjectOptions): Promise<string | null> {
  const spec = hookSpecFor(host)
  if (spec === null || (event.kind !== 'session_start' && event.kind !== 'user_prompt')) return null
  // An agent running this host's hooks under its own name is not known to show the message, so it gets the context alone.
  const hasUserChannel = spec.userMessage !== undefined && event.host === host
  const mayProgress = spec.progressLine !== undefined && event.host === host
  // One read of display.json for both lines, and none when this host shows neither: this runs inside the hook's budget.
  const showRecall = (hasUserChannel || mayProgress) && readDisplayFile(dataDir).showRecall
  const show = hasUserChannel && showRecall
  // A progress line rides in front of the normal output; an agent running this host's hooks under its own name is not known to strip it.
  const progress = mayProgress && showRecall && spec.progressLine !== undefined ? spec.progressLine : null
  const wanted = contextFor(event, host)
  if (wanted === null) {
    if (progress !== null) return event.kind === 'user_prompt' ? progress(NO_PROMPT_MEMORY_LINE) : null
    if (!show) return null
    // The agent takes no memory here, so the daemon is not asked on a prompt; at session start only the header is.
    if (event.kind === 'user_prompt') return printed(spec, null, NO_PROMPT_MEMORY_LINE)
    const header = await fetchContext(dataDir, { host: event.host, cwd: event.cwd, hostSessionId: event.hostSessionId, channel: 'session_start', displayOnly: true },
      { ...inject, log: (line) => stderr(`kinfold-hook: ${line}`) })
    const notice = header.result?.updateNotice
    return printed(spec, null, [...(notice !== undefined ? [noticeMessage(notice)] : []), recallMessage('session_start', header, false)].join('\n'))
  }
  // Own words before any paste, then cut: a long paste must not push the user's words out of the request.
  const prompt = wanted.channel === 'prompt' ? promptForRecall(event.promptText ?? '').slice(0, MAX_CONTEXT_PROMPT_CHARS) : ''
  const fetched = await fetchContext(
    dataDir,
    { host: event.host, cwd: event.cwd, hostSessionId: event.hostSessionId, channel: wanted.channel, ...(prompt.trim() !== '' ? { prompt } : {}) },
    { ...inject, log: (line) => stderr(`kinfold-hook: ${line}`) },
  )
  const result = fetched.result
  // The notice rides on session start only; the route never attaches it to a prompt delta.
  const notice = wanted.channel === 'session_start' ? result?.updateNotice : undefined
  if (!hasUserChannel) {
    // No update notice goes into a model's context. Where the host has a progress line it is shown there; elsewhere status, the dashboard and kinfold watch carry it.
    const normal = result === null || result.text === '' ? null : wanted.render(result.text)
    const progressLine = spec.progressLine !== undefined && event.host === host ? spec.progressLine : null
    const parts = [...(notice !== undefined && progressLine !== null ? [noticeMessage(notice)] : []), ...(progress !== null ? [recallMessage(wanted.channel, fetched, true, true)] : [])]
    if (progressLine === null || parts.length === 0) return normal
    // cleanTitle again, on the whole line: it must stay one line of stdout whatever a title or project name holds.
    const line = progressLine(cleanTitle(parts.join(' · ')))
    return normal === null ? line : `${line}\n${normal}`
  }
  const context = result === null || result.text === '' ? null : wanted.render(result.text)
  const lines = [...(notice !== undefined ? [noticeMessage(notice)] : []), ...(show ? [recallMessage(wanted.channel, fetched, true)] : [])]
  return printed(spec, context, lines.length === 0 ? null : lines.join('\n'))
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
