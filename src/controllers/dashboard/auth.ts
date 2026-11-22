// Dashboard credentials. The dashboard is open only while a `kinfold
// dashboard` command holds a lease: a live lease lapses 15 s after the
// command's last heartbeat (so a killed terminal closes it on its own), a
// --print lease lasts 12 h or until `kinfold dashboard --close`. The daemon
// token never reaches a browser: the command trades it for a one-time login
// code (60 s, single use) under its lease, and the login page trades the code
// for a session cookie (12 h). The running command instead offers one sign-in
// bound to a claim secret it made itself: the daemon is given only the
// secret's SHA-256, and the page that was opened with the secret in its
// address fragment claims the session with it (60 s, single use). A session counts only while the lease it was
// made under is live. A lapse is not a revocation: the command that made the
// id can renew it after a daemon restart longer than 15 s or a suspended
// terminal, and its sessions count again; only the id's holder knows it.
// Releasing the lease (or --close) ends its sessions for good. Codes live in memory;
// sessions and leases are also kept in <data>/dashboard-sessions.json (0600)
// so the daemon restart an update causes does not close the dashboard
// mid-install. Codes and sessions are keyed by the SHA-256 of the secret, so a
// lookup's timing says nothing about the secret itself, and every map is
// capped so a stream of requests cannot grow it without bound.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../../system/fs/atomic'

export const LOGIN_CODE_TTL_MS = 60_000
export const PENDING_SIGN_IN_TTL_MS = 60_000
export const SESSION_TTL_MS = 43_200_000
export const LIVE_LEASE_TTL_MS = 15_000
export const PRINT_LEASE_TTL_MS = 43_200_000
export const SESSION_COOKIE = 'sam_session'
export const MAX_LOGIN_CODES = 16
export const MAX_SESSIONS = 64
export const MAX_LEASES = 16
const SECRET_BYTES = 32
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
export const DASHBOARD_SESSIONS_FILE = 'dashboard-sessions.json'
const SESSIONS_FILE_MODE = 0o600
// The file never holds more than MAX_SESSIONS and MAX_LEASES short rows; anything far larger is not ours.
const MAX_SESSIONS_FILE_BYTES = 64 * 1024

export type LeaseMode = 'live' | 'print'

const LEASE_TTL: Readonly<Record<LeaseMode, number>> = { live: LIVE_LEASE_TTL_MS, print: PRINT_LEASE_TTL_MS }

export interface SessionRecord {
  expiresAt: number
  lease: string
}

export interface LeaseRecord {
  expiresAt: number
  mode: LeaseMode
}

export interface SavedAuth {
  sessions: ReadonlyMap<string, SessionRecord>
  leases: ReadonlyMap<string, LeaseRecord>
}

/** Where session and lease records outlive the daemon. Session keys are SHA-256 digests, so the file cannot be replayed as a cookie. */
export interface SessionStore {
  load(): SavedAuth
  save(saved: SavedAuth): void
}

const EMPTY: SavedAuth = { sessions: new Map(), leases: new Map() }
const memoryStore: SessionStore = { load: () => EMPTY, save: () => {} }

const isLeaseId = (value: unknown): value is string => typeof value === 'string' && SECRET_PATTERN.test(value)

function parseRows<V>(rows: unknown, cap: number, read: (row: unknown[]) => [string, V] | null): Map<string, V> | null {
  if (!Array.isArray(rows) || rows.length > cap) return null
  const parsed = rows.map((row: unknown) => (Array.isArray(row) && row.length === 3 ? read(row) : null))
  return parsed.every((entry) => entry !== null) ? new Map(parsed as [string, V][]) : null
}

function parseSaved(text: string): SavedAuth {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) return EMPTY
  const { sessions, leases } = parsed as { sessions?: unknown; leases?: unknown }
  const sessionRows = parseRows<SessionRecord>(sessions, MAX_SESSIONS, ([key, expiresAt, lease]) =>
    typeof key === 'string' && DIGEST_PATTERN.test(key) && Number.isSafeInteger(expiresAt) && isLeaseId(lease) ? [key, { expiresAt: expiresAt as number, lease }] : null)
  const leaseRows = parseRows<LeaseRecord>(leases, MAX_LEASES, ([id, expiresAt, mode]) =>
    isLeaseId(id) && Number.isSafeInteger(expiresAt) && (mode === 'live' || mode === 'print') ? [id, { expiresAt: expiresAt as number, mode }] : null)
  // A file from before leases has two-column session rows: it reads as empty, which is a closed dashboard.
  return sessionRows === null || leaseRows === null ? EMPTY : { sessions: sessionRows, leases: leaseRows }
}

/** A damaged or unreadable file signs everyone out and closes the dashboard. */
export function fileSessionStore(dataDir: string, log: (line: string) => void = () => {}): SessionStore {
  const path = join(dataDir, DASHBOARD_SESSIONS_FILE)
  return {
    load: () => {
      try {
        const text = readFileSync(path, 'utf8')
        return text.length > MAX_SESSIONS_FILE_BYTES ? EMPTY : parseSaved(text)
      } catch {
        return EMPTY
      }
    },
    save: (saved) => {
      const sessions = [...saved.sessions].map(([key, record]) => [key, record.expiresAt, record.lease])
      const leases = [...saved.leases].map(([id, record]) => [id, record.expiresAt, record.mode])
      try {
        writeFileAtomic(path, JSON.stringify({ sessions, leases }), SESSIONS_FILE_MODE)
      } catch (error: unknown) {
        log(`dashboard sessions not saved reason=${error instanceof Error && 'code' in error ? String(error.code) : 'write'}`)
      }
    },
  }
}

export type SessionState = 'live' | 'closed' | 'none'

export interface IssuedCode {
  code: string
  expiresInMs: number
}

export interface DashboardAuth {
  /** Starts or renews a lease; null for a malformed id or when MAX_LEASES live leases are already held. */
  holdLease(id: string, mode: LeaseMode): { ttlMs: number } | null
  /** Ends a lease and every session made under it; returns how many sessions ended. */
  releaseLease(id: string): number
  /** `kinfold dashboard --close`: ends every --print lease and its sessions; returns how many leases ended. */
  closePrintLeases(): number
  /** True while any lease is live. */
  isOpen(): boolean
  /** A new single-use code under a live lease, or null; the oldest outstanding code is dropped past the cap. */
  issueCode(lease: string): IssuedCode | null
  /**
   * The running command offers one sign-in under its live lease, bound to the
   * SHA-256 (hex) of a claim secret only it and the page it opens know. Null
   * without a live lease or for a malformed digest. A new offer replaces the
   * lease's older one.
   */
  offerSignIn(lease: string, claimDigest: string): { expiresInMs: number } | null
  /**
   * The live offer made for this claim secret becomes a session, once. Null
   * for a wrong, used or expired secret, which leaves every offer as it was:
   * a secret this long cannot be guessed, and dropping the offer on a wrong
   * one would let any local process cancel the user's sign-in.
   */
  claimSignIn(claimSecret: string | null): string | null
  /** 'closed' when the session's own lease ended or lapsed, even while another lease keeps the dashboard open. */
  sessionState(secret: string | null): SessionState
  /** The new session secret, or null for a wrong, used or expired code or a lease that ended. The code is gone either way. */
  redeemCode(code: string): string | null
  hasSession(secret: string | null): boolean
  endSession(secret: string | null): void
  /** Writes the leases' latest expiry if a renewal is unwritten; the daemon calls it on stop, since renewals are not written one by one. */
  flush(): void
}

function newSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

function digest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** Drops expired entries, then the oldest ones past `cap - 1`, so one more fits. */
function pruned<V extends { expiresAt: number }>(entries: ReadonlyMap<string, V>, now: number, cap: number): Map<string, V> {
  const live = [...entries].filter(([, value]) => value.expiresAt > now)
  return new Map(live.slice(Math.max(0, live.length - (cap - 1))))
}

const without = <V>(entries: ReadonlyMap<string, V>, drop: (key: string, value: V) => boolean): Map<string, V> =>
  new Map([...entries].filter(([key, value]) => !drop(key, value)))

/** Map insertion order is issue order, so pruning keeps the newest. */
export function createDashboardAuth(now: () => number = Date.now, store: SessionStore = memoryStore): DashboardAuth {
  const saved = store.load()
  let codes = new Map<string, { expiresAt: number; lease: string }>()
  // Keyed by lease, newest last; holds the claim secret's digest, never the secret.
  let offers = new Map<string, { expiresAt: number; claimDigest: Buffer }>()
  // Sessions a released lease ended, kept until they would have expired so their page can say the dashboard closed. Memory only.
  let closedSessions = new Map<string, { expiresAt: number }>()
  let sessions = without(saved.sessions, (_, record) => record.expiresAt <= now())
  let leases = without(saved.leases, (_, record) => record.expiresAt <= now())
  const valid = (secret: string | null): secret is string => secret !== null && SECRET_PATTERN.test(secret)
  const leaseLive = (id: string): boolean => (leases.get(id)?.expiresAt ?? 0) > now()
  // A renewal that is not written yet; flush() writes only then, so a stopped daemon never recreates a file uninstall removed.
  let unsaved = false
  const save = (): void => {
    unsaved = false
    store.save({ sessions, leases })
  }
  const startSession = (lease: string): string => {
    const secret = newSecret()
    sessions = new Map([...pruned(sessions, now(), MAX_SESSIONS), [digest(secret), { expiresAt: now() + SESSION_TTL_MS, lease }]])
    save()
    return secret
  }
  const endLeases = (ended: ReadonlySet<string>): number => {
    const before = sessions.size
    const endedSessions = [...sessions].filter(([, record]) => ended.has(record.lease)).map(([key, record]) => [key, { expiresAt: record.expiresAt }] as const)
    closedSessions = new Map([...without(closedSessions, (_, record) => record.expiresAt <= now()), ...endedSessions].slice(-MAX_SESSIONS))
    offers = without(offers, (lease) => ended.has(lease))
    leases = without(leases, (id) => ended.has(id))
    sessions = without(sessions, (_, record) => ended.has(record.lease))
    codes = without(codes, (_, record) => ended.has(record.lease))
    save()
    return before - sessions.size
  }
  return {
    holdLease: (id, mode) => {
      if (!isLeaseId(id)) return null
      const live = without(leases, (_, record) => record.expiresAt <= now())
      const isNew = !live.has(id)
      if (isNew && live.size >= MAX_LEASES) return null
      leases = new Map([...without(live, (other) => other === id), [id, { expiresAt: now() + LEASE_TTL[mode], mode }]])
      // A renewal is not written: the heartbeat comes every second, and flush() on stop keeps the latest expiry.
      if (isNew) save()
      else unsaved = true
      return { ttlMs: LEASE_TTL[mode] }
    },
    releaseLease: (id) => endLeases(new Set([id])),
    closePrintLeases: () => {
      const printed = new Set([...leases].filter(([, record]) => record.mode === 'print' && record.expiresAt > now()).map(([id]) => id))
      endLeases(printed)
      return printed.size
    },
    isOpen: () => [...leases.values()].some((record) => record.expiresAt > now()),
    issueCode: (lease) => {
      if (!leaseLive(lease)) return null
      const code = newSecret()
      codes = new Map([...pruned(codes, now(), MAX_LOGIN_CODES), [digest(code), { expiresAt: now() + LOGIN_CODE_TTL_MS, lease }]])
      return { code, expiresInMs: LOGIN_CODE_TTL_MS }
    },
    redeemCode: (code) => {
      if (!valid(code)) return null
      const key = digest(code)
      const issued = codes.get(key)
      codes = without(codes, (other) => other === key)
      if (issued === undefined || issued.expiresAt <= now() || !leaseLive(issued.lease)) return null
      return startSession(issued.lease)
    },
    offerSignIn: (lease, claimDigest) => {
      if (!leaseLive(lease) || !DIGEST_PATTERN.test(claimDigest)) return null
      const offer = { expiresAt: now() + PENDING_SIGN_IN_TTL_MS, claimDigest: Buffer.from(claimDigest, 'hex') }
      offers = new Map([...without(offers, (other, old) => other === lease || old.expiresAt <= now()), [lease, offer]])
      return { expiresInMs: PENDING_SIGN_IN_TTL_MS }
    },
    claimSignIn: (claimSecret) => {
      offers = without(offers, (lease, offer) => offer.expiresAt <= now() || !leaseLive(lease))
      if (!valid(claimSecret)) return null
      const given = createHash('sha256').update(claimSecret).digest()
      const claimed = [...offers].find(([, offer]) => timingSafeEqual(offer.claimDigest, given))
      if (claimed === undefined) return null
      offers = without(offers, (lease) => lease === claimed[0])
      return startSession(claimed[0])
    },
    sessionState: (secret) => {
      if (!valid(secret)) return 'none'
      const key = digest(secret)
      const record = sessions.get(key)
      if (record !== undefined && record.expiresAt > now()) return leaseLive(record.lease) ? 'live' : 'closed'
      return (closedSessions.get(key)?.expiresAt ?? 0) > now() ? 'closed' : 'none'
    },
    hasSession: (secret) => {
      if (!valid(secret)) return false
      const record = sessions.get(digest(secret))
      return record !== undefined && record.expiresAt > now() && leaseLive(record.lease)
    },
    endSession: (secret) => {
      if (!valid(secret)) return
      const key = digest(secret)
      const kept = without(sessions, (other, record) => other === key || record.expiresAt <= now())
      if (kept.size !== sessions.size) {
        sessions = kept
        save()
      }
    },
    flush: () => {
      if (unsaved) save()
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
