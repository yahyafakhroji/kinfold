// The context-pack contract shared by the daemon, the read-only fallback, the
// Claude Code hook and the OpenCode plugin: who asks (host, cwd, host
// session, channel), what comes back (pack text, the observation ids in it,
// its token estimate), and each host profile's token budget.

import { isAbsolute } from 'node:path'
import type { EvidenceStrength } from '../evidence'
import type { FirstScreen, Recalled } from './recall-line'

export const HOST_PROFILES = ['claude-code', 'opencode', 'default'] as const
export type HostProfile = (typeof HOST_PROFILES)[number]

/** Tokens per pack, estimated as chars / 4. */
export const PACK_BUDGETS: Readonly<Record<HostProfile, number>> = { 'claude-code': 2000, opencode: 1200, default: 1500 }

export const CHARS_PER_TOKEN = 4

/**
 * Delivery moments: Claude Code's SessionStart, OpenCode's per-request context
 * hook, and `prompt`, answered with a short delta (what the session has not
 * been sent yet, src/context/delta.ts) for mid-session updates.
 */
export const CONTEXT_CHANNELS = ['session_start', 'request', 'prompt'] as const
export type ContextChannel = (typeof CONTEXT_CHANNELS)[number]

export interface ContextRequest {
  host: string
  cwd: string
  hostSessionId: string
  channel: ContextChannel
  /** The user's prompt, on the prompt channel only: matched to earlier memory, never stored or logged. */
  prompt?: string
  /**
   * Session start only, from an agent whose model takes no pack then: the
   * answer carries the first-screen header and the update notice, no memory,
   * and no injection is recorded.
   */
  displayOnly?: true
}

/**
 * What a hook or plugin shows the user about an answer. None of it reaches the
 * model: `recalled` and `firstScreen` only name ids the answer already carries.
 */
export interface ContextDisplay {
  /** Prompt channel: a title and part for each id sent. */
  recalled?: Recalled[]
  /** Session start and OpenCode's first request: the list's header and newest rows. */
  firstScreen?: FirstScreen
  /** Prompt channel: recall was skipped for the impact test, so `text` is empty. */
  heldOut?: true
}

/** A newer release than the running one; the channel picks the command the user is told to run. */
export const NOTICE_CHANNELS = ['npx', 'bunx', 'curl', 'powershell'] as const
/**
 * What the notice says: a newer release to install by hand (the default, so an
 * absent kind reads as it always did), an update Kinfold installed itself, or
 * that automatic patch updates are now on for an install that predates them.
 */
export const NOTICE_KINDS = ['available', 'updated', 'auto-on', 'offer'] as const
export interface UpdateNotice {
  kind?: (typeof NOTICE_KINDS)[number]
  /** The release on offer, the one just installed, or the running one for `auto-on`. */
  version: string
  /** `updated` only: the version that was running before. */
  previous?: string
  /**
   * `updated` only, on an install from before `kinfold` was put on PATH: the
   * installed program to run with `install`, which is where that is offered.
   * An update never adds it on its own.
   */
  addCommand?: string
  channel: (typeof NOTICE_CHANNELS)[number]
  /** `available` and `offer`: how many change lines the release lists, and how many of them are breaking. Absent: not known. */
  changes?: number
  breaking?: number
  /** The release is a beta: a launcher fetches it from npm's next tag. */
  prerelease?: true
}

export interface ContextResult {
  /** Empty when the project has nothing to recall. */
  text: string
  observationIds: number[]
  tokens: number
  /** Prompt channel: the related-memory block alone, the end of `text`; absent when there is none. */
  relatedText?: string
  /** For the user's screen only; absent from a daemon that predates it. */
  display?: ContextDisplay
  /** Session start and OpenCode's first request only: a release this host has not been told about yet. */
  updateNotice?: UpdateNotice
  /**
   * On the wire only: a notice of a kind other than `available`. It has its own
   * key because a hook or plugin from before these kinds reads `updateNotice`
   * as a release to install, whatever its kind. parseContextResult hands it on
   * as `updateNotice`, so readers look in one place.
   */
  selfNotice?: UpdateNotice
}

/** One stored observation as a pack sees it: no narrative, no facts, no payload. */
export interface PackObservation {
  id: number
  host: string
  title: string
  evidence: EvidenceStrength
  contradictedBy: number | null
  /** The link kind behind contradictedBy; null when there is none or it predates links (v5). */
  contradictionKind: 'updates' | 'contradicts' | null
  occurredAt: number
  /** Current observations that confirm this one; 0 on a store from before v5. */
  confirmedBy: number
}

export const EMPTY_CONTEXT: ContextResult = { text: '', observationIds: [], tokens: 0 }

const HOST_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_CWD_CHARS = 4096
const MAX_HOST_SESSION_CHARS = 256
/** Hosts cut longer prompts to this before sending. */
export const MAX_CONTEXT_PROMPT_CHARS = 2_000

/** "updated by" for an updates link, "contradicted by" otherwise (a contradicts link, or a row hidden before v5). */
export function contradictionLabel(kind: 'updates' | 'contradicts' | null | undefined): string {
  return kind === 'updates' ? 'updated by' : 'contradicted by'
}

export function hostProfileFor(host: string): HostProfile {
  return host === 'claude-code' || host === 'opencode' ? host : 'default'
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/** Validates a POST /context body; error messages name the field, never echo its value. */
export function parseContextRequest(body: unknown): Parsed<ContextRequest> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' }
  const { host, cwd, hostSessionId, channel } = body
  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) return { ok: false, error: 'host must be a short lowercase name' }
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > MAX_CWD_CHARS) return { ok: false, error: 'cwd must be an absolute path' }
  if (typeof hostSessionId !== 'string' || hostSessionId === '' || hostSessionId.length > MAX_HOST_SESSION_CHARS) {
    return { ok: false, error: 'hostSessionId must be a non-empty string' }
  }
  if (!CONTEXT_CHANNELS.includes(channel as ContextChannel)) return { ok: false, error: 'channel must be session_start, request or prompt' }
  const { prompt, displayOnly } = body
  if (displayOnly !== undefined && (displayOnly !== true || channel !== 'session_start')) return { ok: false, error: 'displayOnly must be true, on session_start' }
  const extras: Pick<ContextRequest, 'displayOnly'> = displayOnly === true ? { displayOnly: true } : {}
  if (prompt === undefined) return { ok: true, value: { host, cwd, hostSessionId, channel: channel as ContextChannel, ...extras } }
  if (channel !== 'prompt') return { ok: false, error: 'prompt is only for the prompt channel' }
  if (typeof prompt !== 'string' || prompt.length > MAX_CONTEXT_PROMPT_CHARS) {
    return { ok: false, error: `prompt must be a string of at most ${MAX_CONTEXT_PROMPT_CHARS} chars` }
  }
  return { ok: true, value: { host, cwd, hostSessionId, channel: 'prompt', prompt, ...extras } }
}

const MAX_DISPLAY_TITLE_CHARS = 2_000

function parseRecalled(value: unknown): Recalled[] | null {
  if (!Array.isArray(value)) return null
  const entries: Recalled[] = []
  for (const entry of value) {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.id) || typeof entry.title !== 'string' || (entry.part !== 'related' && entry.part !== 'new')) return null
    entries.push({ id: entry.id as number, title: entry.title.slice(0, MAX_DISPLAY_TITLE_CHARS), part: entry.part })
  }
  return entries
}

function parseFirstScreen(value: unknown): FirstScreen | null {
  if (!isRecord(value) || typeof value.project !== 'string' || !Number.isSafeInteger(value.total) || !Array.isArray(value.rows)) return null
  if (value.lastSessionAt !== null && !Number.isSafeInteger(value.lastSessionAt)) return null
  const rows: FirstScreen['rows'] = []
  for (const row of value.rows) {
    if (!isRecord(row) || !Number.isSafeInteger(row.id) || typeof row.title !== 'string' || !Number.isSafeInteger(row.occurredAt)) return null
    rows.push({ id: row.id as number, title: row.title.slice(0, MAX_DISPLAY_TITLE_CHARS), occurredAt: row.occurredAt as number })
  }
  return { project: value.project.slice(0, MAX_DISPLAY_TITLE_CHARS), total: value.total as number, lastSessionAt: value.lastSessionAt as number | null, rows }
}

/** A malformed part is dropped, never an error: the memory in the answer is still good, and the line falls back to bare ids. */
function parseDisplay(value: unknown): ContextDisplay | null {
  if (!isRecord(value)) return null
  const recalled = value.recalled === undefined ? null : parseRecalled(value.recalled)
  const firstScreen = value.firstScreen === undefined ? null : parseFirstScreen(value.firstScreen)
  return { ...(recalled !== null ? { recalled } : {}), ...(firstScreen !== null ? { firstScreen } : {}), ...(value.heldOut === true ? { heldOut: true as const } : {}) }
}

/** Checks a daemon reply before the hook or plugin trusts it. */
export function parseContextResult(body: unknown): ContextResult | null {
  if (!isRecord(body)) return null
  const { text, observationIds, tokens, relatedText, updateNotice, selfNotice } = body
  if (typeof text !== 'string' || typeof tokens !== 'number' || !Array.isArray(observationIds)) return null
  if (!observationIds.every((id) => Number.isSafeInteger(id))) return null
  const notice = parseAvailableNotice(updateNotice) ?? parseSelfNotice(selfNotice)
  const display = parseDisplay(body.display)
  const result = { text, observationIds: observationIds as number[], tokens, ...(display !== null ? { display } : {}), ...(notice !== null ? { updateNotice: notice } : {}) }
  if (relatedText === undefined) return result
  if (typeof relatedText !== 'string' || relatedText === '' || !text.endsWith(relatedText)) return null
  return { ...result, relatedText }
}

/** A malformed notice is dropped, never an error: the pack is still good. The version is only ever printed, so it stays short and plain. */
function parseAvailableNotice(value: unknown): UpdateNotice | null {
  if (!isRecord(value)) return null
  const { version, channel } = value
  const known = NOTICE_CHANNELS.find((name) => name === channel)
  return isPrintableVersion(version) && known !== undefined ? { version, channel: known, ...releaseFields(value) } : null
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1000

/** The counts travel as a pair or not at all, so a line never says "3 changes" beside a made-up breaking count. */
function releaseFields(value: Record<string, unknown>): Pick<UpdateNotice, 'changes' | 'breaking' | 'prerelease'> {
  return {
    ...(isCount(value.changes) && isCount(value.breaking) ? { changes: value.changes, breaking: value.breaking } : {}),
    ...(value.prerelease === true ? { prerelease: true as const } : {}),
  }
}

/** A kind this build does not know has no wording here, so it is dropped rather than shown as the wrong thing. */
function parseSelfNotice(value: unknown): UpdateNotice | null {
  if (!isRecord(value)) return null
  const { kind, version, previous, channel } = value
  const known = NOTICE_CHANNELS.find((name) => name === channel)
  if (!isPrintableVersion(version) || known === undefined) return null
  if (kind === 'auto-on') return { kind, version, channel: known }
  if (kind === 'offer') return { kind, version, channel: known, ...releaseFields(value) }
  if (kind === 'updated' && isPrintableVersion(previous)) return { kind, version, previous, channel: known, ...(isPlainPath(value.addCommand) ? { addCommand: value.addCommand } : {}) }
  return null
}

/** A path and nothing else: the text is shown to a person and handed to an agent, so no quote, backtick, `$` or line break passes. */
function isPlainPath(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9 _.~%:\\/-]{1,300}$/.test(value)
}

function isPrintableVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(value)
}
