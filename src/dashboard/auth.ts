// Dashboard credentials, held in memory only (a daemon restart logs everyone
// out). The daemon token never reaches a browser: `kinfold dashboard` trades it
// for a one-time login code (60 s, single use), and the login page trades the
// code for a session cookie (12 h). Both maps are keyed by the SHA-256 of the
// secret, so a lookup's timing says nothing about the secret itself, and both
// are capped so a stream of requests cannot grow them without bound.

import { createHash, randomBytes } from 'node:crypto'

export const LOGIN_CODE_TTL_MS = 60_000
export const SESSION_TTL_MS = 43_200_000
export const SESSION_COOKIE = 'sam_session'
export const MAX_LOGIN_CODES = 16
export const MAX_SESSIONS = 64
const SECRET_BYTES = 32
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface IssuedCode {
  code: string
  expiresInMs: number
}

export interface DashboardAuth {
  /** A new single-use code; the oldest outstanding code is dropped past the cap. */
  issueCode(): IssuedCode
  /** The new session secret, or null for a wrong, used or expired code. The code is gone either way. */
  redeemCode(code: string): string | null
  hasSession(secret: string | null): boolean
  endSession(secret: string | null): void
}

function newSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

function digest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** Drops expired entries, then the oldest ones past `cap - 1`, so one more fits. */
function pruned(entries: ReadonlyMap<string, number>, now: number, cap: number): Map<string, number> {
  const live = [...entries].filter(([, expiresAt]) => expiresAt > now)
  return new Map(live.slice(Math.max(0, live.length - (cap - 1))))
}

/** Map insertion order is issue order, so pruning keeps the newest. */
export function createDashboardAuth(now: () => number = Date.now): DashboardAuth {
  let codes = new Map<string, number>()
  let sessions = new Map<string, number>()
  const valid = (secret: string | null): secret is string => secret !== null && SECRET_PATTERN.test(secret)
  return {
    issueCode: () => {
      const code = newSecret()
      codes = new Map([...pruned(codes, now(), MAX_LOGIN_CODES), [digest(code), now() + LOGIN_CODE_TTL_MS]])
      return { code, expiresInMs: LOGIN_CODE_TTL_MS }
    },
    redeemCode: (code) => {
      if (!valid(code)) return null
      const key = digest(code)
      const expiresAt = codes.get(key)
      codes = new Map([...codes].filter(([other]) => other !== key))
      if (expiresAt === undefined || expiresAt <= now()) return null
      const secret = newSecret()
      sessions = new Map([...pruned(sessions, now(), MAX_SESSIONS), [digest(secret), now() + SESSION_TTL_MS]])
      return secret
    },
    hasSession: (secret) => {
      if (!valid(secret)) return false
      const expiresAt = sessions.get(digest(secret))
      return expiresAt !== undefined && expiresAt > now()
    },
    endSession: (secret) => {
      if (!valid(secret)) return
      const key = digest(secret)
      sessions = new Map([...sessions].filter(([other]) => other !== key))
    },
  }
}

/** The session cookie's value from a Cookie header, or null. */
export function sessionFromCookie(header: string | null): string | null {
  if (header === null) return null
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === SESSION_COOKIE) return part.slice(at + 1).trim()
  }
  return null
}

/** No Secure flag: the dashboard is plain HTTP on loopback, where a Secure cookie would never be sent. */
export function sessionCookie(secret: string): string {
  return `${SESSION_COOKIE}=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
}
