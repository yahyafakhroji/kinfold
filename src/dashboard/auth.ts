// Dashboard credentials. Login codes live in memory only; session records are
// also kept in <data>/dashboard-sessions.json (0600) so the daemon restart an
// update causes does not sign the user out mid-install. The daemon token never reaches a browser: `kinfold dashboard` trades it
// for a one-time login code (60 s, single use), and the login page trades the
// code for a session cookie (12 h). Both maps are keyed by the SHA-256 of the
// secret, so a lookup's timing says nothing about the secret itself, and both
// are capped so a stream of requests cannot grow them without bound.

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../fs/atomic'

export const LOGIN_CODE_TTL_MS = 60_000
export const SESSION_TTL_MS = 43_200_000
export const SESSION_COOKIE = 'sam_session'
export const MAX_LOGIN_CODES = 16
export const MAX_SESSIONS = 64
const SECRET_BYTES = 32
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
export const DASHBOARD_SESSIONS_FILE = 'dashboard-sessions.json'
const SESSIONS_FILE_MODE = 0o600
// The file never holds more than MAX_SESSIONS short rows; anything far larger is not ours.
const MAX_SESSIONS_FILE_BYTES = 64 * 1024

/** Where session records outlive the daemon. Keys are SHA-256 digests, so the file cannot be replayed as a cookie. */
export interface SessionStore {
  load(): ReadonlyMap<string, number>
  save(sessions: ReadonlyMap<string, number>): void
}

const memoryStore: SessionStore = { load: () => new Map(), save: () => {} }

function parseSessions(text: string): Map<string, number> {
  const parsed: unknown = JSON.parse(text)
  const rows = typeof parsed === 'object' && parsed !== null ? (parsed as { sessions?: unknown }).sessions : undefined
  if (!Array.isArray(rows) || rows.length > MAX_SESSIONS) return new Map()
  const valid = rows.every((row: unknown) => Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && DIGEST_PATTERN.test(row[0]) && Number.isSafeInteger(row[1]))
  return valid ? new Map(rows as [string, number][]) : new Map()
}

/** A damaged or unreadable file signs everyone out, the same as before sessions were kept. */
export function fileSessionStore(dataDir: string, log: (line: string) => void = () => {}): SessionStore {
  const path = join(dataDir, DASHBOARD_SESSIONS_FILE)
  return {
    load: () => {
      try {
        const text = readFileSync(path, 'utf8')
        return text.length > MAX_SESSIONS_FILE_BYTES ? new Map() : parseSessions(text)
      } catch {
        return new Map()
      }
    },
    save: (sessions) => {
      try {
        writeFileAtomic(path, JSON.stringify({ sessions: [...sessions] }), SESSIONS_FILE_MODE)
      } catch (error: unknown) {
        log(`dashboard sessions not saved reason=${error instanceof Error && 'code' in error ? String(error.code) : 'write'}`)
      }
    },
  }
}

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
export function createDashboardAuth(now: () => number = Date.now, store: SessionStore = memoryStore): DashboardAuth {
  let codes = new Map<string, number>()
  let sessions = new Map([...store.load()].filter(([, expiresAt]) => expiresAt > now()))
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
      store.save(sessions)
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
      const kept = new Map([...sessions].filter(([other, expiresAt]) => other !== key && expiresAt > now()))
      if (kept.size !== sessions.size) store.save(kept)
      sessions = kept
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
