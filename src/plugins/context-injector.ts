// OpenCode's per-request context injection. OpenCode calls the context hook on
// every model request with that request's system parts; the pack is fetched
// once per session, cached (the promise, so concurrent requests share one
// fetch), and appended as one text part. Existing parts are never changed or
// removed; if the same text is already there, nothing is added, so a reused
// list never holds it twice. Compaction drops the session's cache, so the
// next request fetches a pack that reflects what was learned meanwhile.
// Mid-session updates (P1-H): a request may also ask for the prompt-time
// delta (memory written since this session last received it), at most once
// per request and at most once per DELTA_INTERVAL_MS per session. Each
// non-empty delta joins the session's cache and is appended after the pack
// on every later request, up to MAX_DELTAS_PER_SESSION (the oldest goes).
// Prompt-time related memory (P2-B): the prompt hook leaves the session's
// latest prompt here (memory only, cut to MAX_CONTEXT_PROMPT_CHARS); the next
// request asks for the delta at once, interval or not, and sends the prompt
// with it, once. The daemon does the leak check before anything is embedded.
// The answer's related block (relatedText) is kept apart from the deltas and
// replaced by the next prompt's: it matches one prompt, so it is not sticky.
// Logs carry session ids, counts and durations only, never prompt text.

import { type ContextRequest, type ContextResult, MAX_CONTEXT_PROMPT_CHARS } from '../context/types'

export const MAX_CACHED_SESSIONS = 256
export const DELTA_INTERVAL_MS = 30_000
/** About 2,400 tokens at the 300-token delta cap. */
export const MAX_DELTAS_PER_SESSION = 8

export interface ContextInjectorOptions {
  host: string
  cwd: string
  fetch: (request: ContextRequest) => Promise<ContextResult | null>
  log: (line: string) => void
  deltaIntervalMs?: number
  now?: () => number
}

export interface ContextInjector {
  onContext: (event: unknown) => Promise<void>
  /** OpenCode's prompt hook event; keeps its text for the session's next delta ask. */
  onPrompt: (event: unknown) => void
  onCompaction: (event: unknown) => void
  cachedSessions: () => string[]
}

interface SystemPart {
  type: string
  text?: string
}

interface SessionCache {
  pack: Promise<ContextResult | null>
  deltas: readonly string[]
  /** The latest prompt's related memory; replaced by each prompt's answer. */
  related: string
  /** When the pack or the last delta was asked for; the next delta waits DELTA_INTERVAL_MS from here. */
  askedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function sessionOf(event: unknown): string | null {
  return isRecord(event) && typeof event.sessionID === 'string' && event.sessionID !== '' ? event.sessionID : null
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error'
}

export function createContextInjector(options: ContextInjectorOptions): ContextInjector {
  const cache = new Map<string, SessionCache>()
  /** The latest prompt per session not yet sent; bounded like the cache. */
  const pending = new Map<string, string>()
  const now = options.now ?? Date.now
  const interval = options.deltaIntervalMs ?? DELTA_INTERVAL_MS

  const ask = (sessionId: string, channel: 'request' | 'prompt', prompt?: string): Promise<ContextResult | null> => {
    const startedAt = Date.now()
    const kind = channel === 'request' ? 'context' : 'delta'
    const request: ContextRequest = { host: options.host, cwd: options.cwd, hostSessionId: sessionId, channel, ...(prompt !== undefined ? { prompt } : {}) }
    return options.fetch(request).then(
      (result) => {
        options.log(`kinfold-opencode: ${kind} session=${sessionId} ids=${result?.observationIds.length ?? 0} tokens=${result?.tokens ?? 0} ms=${Date.now() - startedAt}`)
        return result
      },
      (error: unknown) => {
        options.log(`kinfold-opencode: ${kind} session=${sessionId} failed: ${errorName(error)}`)
        return null
      },
    )
  }

  const entryFor = (sessionId: string): SessionCache => {
    const cached = cache.get(sessionId)
    if (cached !== undefined) return cached
    const oldest = cache.keys().next()
    if (cache.size >= MAX_CACHED_SESSIONS && oldest.done !== true) cache.delete(oldest.value)
    const entry: SessionCache = { pack: ask(sessionId, 'request'), deltas: [], related: '', askedAt: now() }
    cache.set(sessionId, entry)
    return entry
  }

  /**
   * One delta fetch when a new prompt waits or the interval has passed; the
   * slot and the prompt are taken before the await, so concurrent requests
   * do not both ask and a prompt is sent once.
   */
  const refreshDelta = async (sessionId: string): Promise<void> => {
    const entry = cache.get(sessionId)
    const prompt = pending.get(sessionId)
    if (entry === undefined || (prompt === undefined && now() - entry.askedAt < interval)) return
    pending.delete(sessionId)
    cache.set(sessionId, { ...entry, askedAt: now() })
    const delta = await ask(sessionId, 'prompt', prompt)
    const current = cache.get(sessionId)
    // Compaction may have dropped the session meanwhile; its next pack covers this delta.
    if (current === undefined) return
    const relatedText = delta?.relatedText ?? ''
    const deltaText = delta === null ? '' : delta.text.slice(0, delta.text.length - relatedText.length).replace(/\n$/, '')
    cache.set(sessionId, {
      ...current,
      deltas: deltaText === '' ? current.deltas : [...current.deltas, deltaText].slice(-MAX_DELTAS_PER_SESSION),
      related: prompt === undefined ? current.related : relatedText,
    })
  }

  const onContext = async (event: unknown): Promise<void> => {
    const sessionId = sessionOf(event)
    if (sessionId === null || !isRecord(event) || !Array.isArray(event.system)) return
    const system = event.system as SystemPart[]
    const pack = await entryFor(sessionId).pack
    await refreshDelta(sessionId)
    const session = cache.get(sessionId)
    const texts = [pack?.text ?? '', ...(session?.deltas ?? []), session?.related ?? ''].filter((text) => text !== '')
    for (const text of texts) {
      if (system.some((part) => isRecord(part) && part.text === text)) continue
      // OpenCode's context hook takes additions by mutating event.system; appending is the only change made.
      system.push({ type: 'text', text })
    }
  }

  const onPrompt = (event: unknown): void => {
    const sessionId = sessionOf(event)
    if (sessionId === null || !isRecord(event) || !isRecord(event.prompt) || typeof event.prompt.text !== 'string') return
    const text = event.prompt.text.slice(0, MAX_CONTEXT_PROMPT_CHARS)
    if (text.trim() === '') return
    pending.delete(sessionId)
    const oldest = pending.keys().next()
    if (pending.size >= MAX_CACHED_SESSIONS && oldest.done !== true) pending.delete(oldest.value)
    pending.set(sessionId, text)
  }

  const onCompaction = (event: unknown): void => {
    const sessionId = sessionOf(event)
    if (sessionId !== null && cache.delete(sessionId)) options.log(`kinfold-opencode: context cache dropped session=${sessionId} (compaction)`)
  }

  return { onContext, onPrompt, onCompaction, cachedSessions: () => [...cache.keys()] }
}
