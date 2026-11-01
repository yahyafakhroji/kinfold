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
  /** The user's prompt, on the prompt channel only (P2-B): matched to earlier memory, never stored or logged. */
  prompt?: string
}

export interface ContextResult {
  /** Empty when the project has nothing to recall. */
  text: string
  observationIds: number[]
  tokens: number
  /** Prompt channel: the related-memory block alone, the end of `text`; absent when there is none. */
  relatedText?: string
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
  /** Current observations that confirm this one (P1-I); 0 on a store from before v5. */
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
  const { text, observationIds, tokens, relatedText } = body
  if (typeof text !== 'string' || typeof tokens !== 'number' || !Array.isArray(observationIds)) return null
  if (!observationIds.every((id) => Number.isSafeInteger(id))) return null
  const result = { text, observationIds: observationIds as number[], tokens }
  if (relatedText === undefined) return result
  if (typeof relatedText !== 'string' || relatedText === '' || !text.endsWith(relatedText)) return null
  return { ...result, relatedText }
}
