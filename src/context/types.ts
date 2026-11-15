// The context-pack contract shared by the daemon, the read-only fallback, the
// Claude Code hook and the OpenCode plugin: who asks (host, cwd, host
// session, channel), what comes back (pack text, the observation ids in it,
// its token estimate), and each host profile's token budget.

import { isAbsolute } from 'node:path'
import type { EvidenceStrength } from '../evidence'

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
}

/** A newer release than the running one; the channel picks the command the user is told to run. */
export const NOTICE_CHANNELS = ['npx', 'bunx', 'curl', 'powershell'] as const
/**
 * What the notice says: a newer release to install by hand (the default, so an
 * absent kind reads as it always did), an update Kinfold installed itself, or
 * that automatic patch updates are now on for an install that predates them.
 */
export const NOTICE_KINDS = ['available', 'updated', 'auto-on'] as const
export interface UpdateNotice {
  kind?: (typeof NOTICE_KINDS)[number]
  /** The release on offer, the one just installed, or the running one for `auto-on`. */
  version: string
  /** `updated` only: the version that was running before. */
  previous?: string
  channel: (typeof NOTICE_CHANNELS)[number]
}

export interface ContextResult {
  /** Empty when the project has nothing to recall. */
  text: string
  observationIds: number[]
  tokens: number
  /** Prompt channel: the related-memory block alone, the end of `text`; absent when there is none. */
  relatedText?: string
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
  const { prompt } = body
  if (prompt === undefined) return { ok: true, value: { host, cwd, hostSessionId, channel: channel as ContextChannel } }
  if (channel !== 'prompt') return { ok: false, error: 'prompt is only for the prompt channel' }
  if (typeof prompt !== 'string' || prompt.length > MAX_CONTEXT_PROMPT_CHARS) {
    return { ok: false, error: `prompt must be a string of at most ${MAX_CONTEXT_PROMPT_CHARS} chars` }
  }
  return { ok: true, value: { host, cwd, hostSessionId, channel: 'prompt', prompt } }
}

/** Checks a daemon reply before the hook or plugin trusts it. */
export function parseContextResult(body: unknown): ContextResult | null {
  if (!isRecord(body)) return null
  const { text, observationIds, tokens, relatedText, updateNotice, selfNotice } = body
  if (typeof text !== 'string' || typeof tokens !== 'number' || !Array.isArray(observationIds)) return null
  if (!observationIds.every((id) => Number.isSafeInteger(id))) return null
  const notice = parseAvailableNotice(updateNotice) ?? parseSelfNotice(selfNotice)
  const result = { text, observationIds: observationIds as number[], tokens, ...(notice !== null ? { updateNotice: notice } : {}) }
  if (relatedText === undefined) return result
  if (typeof relatedText !== 'string' || relatedText === '' || !text.endsWith(relatedText)) return null
  return { ...result, relatedText }
}

/** A malformed notice is dropped, never an error: the pack is still good. The version is only ever printed, so it stays short and plain. */
function parseAvailableNotice(value: unknown): UpdateNotice | null {
  if (!isRecord(value)) return null
  const { version, channel } = value
  const known = NOTICE_CHANNELS.find((name) => name === channel)
  return isPrintableVersion(version) && known !== undefined ? { version, channel: known } : null
}

/** A kind this build does not know has no wording here, so it is dropped rather than shown as the wrong thing. */
function parseSelfNotice(value: unknown): UpdateNotice | null {
  if (!isRecord(value)) return null
  const { kind, version, previous, channel } = value
  const known = NOTICE_CHANNELS.find((name) => name === channel)
  if (!isPrintableVersion(version) || known === undefined) return null
  if (kind === 'auto-on') return { kind, version, channel: known }
  if (kind === 'updated' && isPrintableVersion(previous)) return { kind, version, previous, channel: known }
  return null
}

function isPrintableVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(value)
}
