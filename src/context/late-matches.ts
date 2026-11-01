// Vector matches that finished after a prompt's deadline (P2-B, "late
// delivery", the user's choice on 2026-10-26). A remote embed takes longer
// than the prompt hook may wait, so it keeps running; its hits are parked
// here per host session and offered with that session's next prompt, gated
// and filtered against what was sent by then. Memory only: a restart loses
// at most one prompt's worth. Ids and distances, never text.

export const LATE_MAX_SESSIONS = 256
/** Hits older than this belong to a conversation that has moved on. */
export const LATE_TTL_MS = 30 * 60_000

export interface LateHit {
  id: number
  distance: number
  matchedTerms: number
  promptTerms: number
}

export interface LateMatches {
  /**
   * Replaces what the session had parked, unless that came from a newer
   * prompt (`askedAt`, when the prompt was asked): embeds can finish out of
   * order. An empty answer from a newer prompt clears older hits.
   */
  put(sessionKey: string, hits: readonly LateHit[], at: number, askedAt?: number): void
  /** What the session has parked, removed; empty when none or expired. */
  take(sessionKey: string, now: number): LateHit[]
}

export function lateSessionKey(host: string, hostSessionId: string): string {
  return `${host}\u0000${hostSessionId}`
}

export function createLateMatches(maxSessions: number = LATE_MAX_SESSIONS, ttlMs: number = LATE_TTL_MS): LateMatches {
  const parked = new Map<string, { hits: LateHit[]; at: number; askedAt: number }>()
  /** When each session's newest put was asked; kept after a take, so an older answer arriving later is still refused. */
  const newest = new Map<string, number>()
  return {
    put: (key, hits, at, askedAt = at) => {
      if ((newest.get(key) ?? -Infinity) > askedAt) return
      newest.delete(key)
      newest.set(key, askedAt)
      if (newest.size > maxSessions) newest.delete(newest.keys().next().value!)
      parked.delete(key)
      if (hits.length === 0) return
      parked.set(key, { hits: [...hits], at, askedAt })
      if (parked.size > maxSessions) parked.delete(parked.keys().next().value!)
    },
    take: (key, now) => {
      const entry = parked.get(key)
      parked.delete(key)
      return entry === undefined || now - entry.at > ttlMs ? [] : entry.hits
    },
  }
}
