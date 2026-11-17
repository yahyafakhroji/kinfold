import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DASHBOARD_SESSIONS_FILE, type DashboardAuth, LIVE_LEASE_TTL_MS, PENDING_SIGN_IN_TTL_MS, LOGIN_CODE_TTL_MS, MAX_LEASES, MAX_LOGIN_CODES, MAX_SESSIONS, PRINT_LEASE_TTL_MS, SESSION_TTL_MS, createDashboardAuth, fileSessionStore, sessionCookie, sessionFromCookie } from './auth'

function clock(start: number = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return { now: () => at, advance: (ms) => { at += ms } }
}

const LEASE = 'L'.repeat(43)
const OTHER_LEASE = 'M'.repeat(43)

/** A code under a print lease, which lasts 12 h: these tests are about codes and sessions, not leases. */
function codeFor(auth: DashboardAuth, lease: string = LEASE): string {
  auth.holdLease(lease, 'print')
  const issued = auth.issueCode(lease)
  if (issued === null) throw new Error('no code issued')
  return issued.code
}

test('a login code works once', () => {
  const auth = createDashboardAuth()
  const code = codeFor(auth)
  const session = auth.redeemCode(code)
  expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(auth.hasSession(session)).toBe(true)
  expect(auth.redeemCode(code)).toBeNull()
})

test('a login code expires after 60 s', () => {
  const time = clock()
  const auth = createDashboardAuth(time.now)
  auth.holdLease(LEASE, 'print')
  const early = auth.issueCode(LEASE)!
  const late = auth.issueCode(LEASE)!
  time.advance(LOGIN_CODE_TTL_MS - 1)
  expect(auth.redeemCode(early.code)).not.toBeNull()
  time.advance(1)
  expect(auth.redeemCode(late.code)).toBeNull()
  expect(early.expiresInMs).toBe(60_000)
})

test('a wrong or malformed code is refused and burns nothing else', () => {
  const auth = createDashboardAuth()
  const code = codeFor(auth)
  const wrong = `${code.slice(0, -1)}${code.endsWith('A') ? 'B' : 'A'}`
  for (const attempt of [wrong, '', 'x', `${code}x`, code.toUpperCase() === code ? 'Z'.repeat(43) : code.toUpperCase()]) {
    expect(auth.redeemCode(attempt)).toBeNull()
  }
  expect(auth.redeemCode(code)).not.toBeNull()
})

test('sessions last 12 h, end on sign-out, and only the live secret counts', () => {
  const time = clock()
  const auth = createDashboardAuth(time.now)
  const session = auth.redeemCode(codeFor(auth))!
  const other = auth.redeemCode(codeFor(auth))!
  expect(auth.hasSession(null)).toBe(false)
  expect(auth.hasSession('A'.repeat(43))).toBe(false)
  auth.endSession(other)
  expect(auth.hasSession(other)).toBe(false)
  time.advance(SESSION_TTL_MS - 1)
  expect(auth.hasSession(session)).toBe(true)
  time.advance(1)
  expect(auth.hasSession(session)).toBe(false)
})

test('outstanding codes are capped; the oldest goes first', () => {
  const auth = createDashboardAuth()
  const codes = Array.from({ length: MAX_LOGIN_CODES + 1 }, () => codeFor(auth))
  expect(auth.redeemCode(codes[0]!)).toBeNull()
  expect(auth.redeemCode(codes.at(-1)!)).not.toBeNull()
})

test('the session cookie is HttpOnly, SameSite=Strict, Path=/, 12 h, and not Secure', () => {
  const cookie = sessionCookie('s'.repeat(43))
  expect(cookie).toBe(`sam_session=${'s'.repeat(43)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`)
  expect(cookie).not.toContain('Secure')
  expect(sessionFromCookie(`theme=dark; sam_session=${'s'.repeat(43)}; other=1`)).toBe('s'.repeat(43))
  expect(sessionFromCookie('sam_sessionx=1')).toBeNull()
  expect(sessionFromCookie(null)).toBeNull()
})

describe('leases: the dashboard is open only while a kinfold dashboard command holds one', () => {
  test('with no lease the dashboard is closed and no code is issued', () => {
    const auth = createDashboardAuth()
    expect(auth.isOpen()).toBe(false)
    expect(auth.issueCode(LEASE)).toBeNull()
    expect(auth.holdLease('short', 'live')).toBeNull()
  })

  test('a live lease lapses 15 s after its last renewal, and its sessions stop counting (a killed command)', () => {
    const time = clock()
    const auth = createDashboardAuth(time.now)
    expect(auth.holdLease(LEASE, 'live')).toEqual({ ttlMs: LIVE_LEASE_TTL_MS })
    const session = auth.redeemCode(auth.issueCode(LEASE)!.code)!
    time.advance(LIVE_LEASE_TTL_MS - 1)
    auth.holdLease(LEASE, 'live')
    time.advance(LIVE_LEASE_TTL_MS - 1)
    expect(auth.isOpen()).toBe(true)
    expect(auth.hasSession(session)).toBe(true)
    time.advance(1)
    expect(auth.isOpen()).toBe(false)
    expect(auth.hasSession(session)).toBe(false)
  })

  test('a lapse is not a revocation: the command that holds the id can renew it after a long restart or a suspended terminal', () => {
    const time = clock()
    const auth = createDashboardAuth(time.now)
    auth.holdLease(LEASE, 'live')
    const session = auth.redeemCode(auth.issueCode(LEASE)!.code)!
    time.advance(3_600_000)
    expect(auth.hasSession(session)).toBe(false)
    auth.holdLease(LEASE, 'live')
    expect(auth.hasSession(session)).toBe(true)
  })

  test('releasing a lease (Ctrl-C) ends the sessions it created and leaves the others', () => {
    const auth = createDashboardAuth()
    auth.holdLease(LEASE, 'live')
    auth.holdLease(OTHER_LEASE, 'live')
    const mine = auth.redeemCode(auth.issueCode(LEASE)!.code)!
    const theirs = auth.redeemCode(auth.issueCode(OTHER_LEASE)!.code)!
    expect(auth.releaseLease(LEASE)).toBe(1)
    expect(auth.hasSession(mine)).toBe(false)
    expect(auth.hasSession(theirs)).toBe(true)
    expect(auth.isOpen()).toBe(true)
    // Holding the same id again does not bring an ended session back.
    auth.holdLease(LEASE, 'live')
    expect(auth.hasSession(mine)).toBe(false)
    expect(auth.releaseLease(OTHER_LEASE)).toBe(1)
    expect(auth.releaseLease(OTHER_LEASE)).toBe(0)
  })

  test('a code outlives nothing: one issued under a lease that ended cannot be redeemed', () => {
    const auth = createDashboardAuth()
    auth.holdLease(LEASE, 'live')
    const { code } = auth.issueCode(LEASE)!
    auth.releaseLease(LEASE)
    expect(auth.redeemCode(code)).toBeNull()
  })

  test('a print lease lasts 12 h and only --close ends it among the leases', () => {
    const time = clock()
    const auth = createDashboardAuth(time.now)
    expect(auth.holdLease(LEASE, 'print')).toEqual({ ttlMs: PRINT_LEASE_TTL_MS })
    auth.holdLease(OTHER_LEASE, 'live')
    const printed = auth.redeemCode(auth.issueCode(LEASE)!.code)!
    expect(auth.closePrintLeases()).toBe(1)
    expect(auth.hasSession(printed)).toBe(false)
    expect(auth.isOpen()).toBe(true)
    auth.holdLease(LEASE, 'print')
    time.advance(PRINT_LEASE_TTL_MS)
    expect(auth.issueCode(LEASE)).toBeNull()
  })

  test('live leases are capped; expired ones make room', () => {
    const time = clock()
    const auth = createDashboardAuth(time.now)
    const ids = Array.from({ length: MAX_LEASES + 1 }, (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(41)}`)
    for (const id of ids.slice(0, MAX_LEASES)) expect(auth.holdLease(id, 'live')).not.toBeNull()
    expect(auth.holdLease(ids.at(-1)!, 'live')).toBeNull()
    expect(auth.holdLease(ids[0]!, 'live')).not.toBeNull()
    time.advance(LIVE_LEASE_TTL_MS)
    expect(auth.holdLease(ids.at(-1)!, 'live')).not.toBeNull()
  })
})

describe('pending sign-ins: the browser opens a plain address and claims what the command offered', () => {
  test('a pending sign-in is claimed once; a second claim gets nothing', () => {
    const auth = createDashboardAuth()
    auth.holdLease(LEASE, 'live')
    expect(auth.offerSignIn(LEASE)).toEqual({ expiresInMs: PENDING_SIGN_IN_TTL_MS })
    const session = auth.claimSignIn()
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(auth.hasSession(session)).toBe(true)
    expect(auth.claimSignIn()).toBeNull()
  })

  test('no offer without a live lease, and none to claim after the lease ends (Ctrl-C)', () => {
    const auth = createDashboardAuth()
    expect(auth.offerSignIn(LEASE)).toBeNull()
    auth.holdLease(LEASE, 'live')
    auth.offerSignIn(LEASE)
    auth.releaseLease(LEASE)
    expect(auth.claimSignIn()).toBeNull()
  })

  test('an offer expires, and one whose lease lapsed cannot be claimed', () => {
    const time = clock()
    const auth = createDashboardAuth(time.now)
    auth.holdLease(LEASE, 'live')
    auth.offerSignIn(LEASE)
    time.advance(PENDING_SIGN_IN_TTL_MS)
    auth.holdLease(LEASE, 'live')
    expect(auth.claimSignIn()).toBeNull()
    auth.offerSignIn(LEASE)
    time.advance(LIVE_LEASE_TTL_MS)
    expect(auth.claimSignIn()).toBeNull()
  })

  test('each command offers its own; the newest offer is claimed first, and a new offer replaces the old one of the same lease', () => {
    const auth = createDashboardAuth()
    auth.holdLease(LEASE, 'live')
    auth.holdLease(OTHER_LEASE, 'live')
    auth.offerSignIn(LEASE)
    auth.offerSignIn(LEASE)
    auth.offerSignIn(OTHER_LEASE)
    const theirs = auth.claimSignIn()!
    const mine = auth.claimSignIn()!
    expect(auth.claimSignIn()).toBeNull()
    auth.releaseLease(OTHER_LEASE)
    expect(auth.hasSession(theirs)).toBe(false)
    expect(auth.hasSession(mine)).toBe(true)
  })
})

describe('a session whose own command ended reads as closed, even while another command runs', () => {
  test('released, lapsed, live and unknown sessions', () => {
    const time = clock()
    const auth = createDashboardAuth(time.now)
    auth.holdLease(LEASE, 'live')
    auth.holdLease(OTHER_LEASE, 'print')
    auth.offerSignIn(LEASE)
    const released = auth.claimSignIn()!
    auth.offerSignIn(OTHER_LEASE)
    const live = auth.claimSignIn()!
    expect(auth.sessionState(released)).toBe('live')
    auth.releaseLease(LEASE)
    expect(auth.isOpen()).toBe(true)
    expect(auth.sessionState(released)).toBe('closed')
    expect(auth.sessionState(live)).toBe('live')
    expect(auth.sessionState('Z'.repeat(43))).toBe('none')
    expect(auth.sessionState(null)).toBe('none')
    auth.holdLease(LEASE, 'live')
    auth.offerSignIn(LEASE)
    const lapsing = auth.claimSignIn()!
    time.advance(LIVE_LEASE_TTL_MS)
    expect(auth.sessionState(lapsing)).toBe('closed')
    auth.endSession(live)
    expect(auth.sessionState(live)).toBe('none')
  })
})

describe('sessions kept in the data folder', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kinfold-auth-')) })
  afterEach(() => { if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true }) })

  test('a session issued before a daemon restart still works after it, with the same expiry', () => {
    const time = clock()
    const before = createDashboardAuth(time.now, fileSessionStore(dir))
    const session = before.redeemCode(codeFor(before))!
    const after = createDashboardAuth(time.now, fileSessionStore(dir))
    expect(after.hasSession(session)).toBe(true)
    time.advance(SESSION_TTL_MS)
    expect(after.hasSession(session)).toBe(false)
  })

  test('sign-out survives a restart, and the file is 0600 and never holds the secret', () => {
    const time = clock()
    const before = createDashboardAuth(time.now, fileSessionStore(dir))
    const kept = before.redeemCode(codeFor(before))!
    const ended = before.redeemCode(codeFor(before))!
    before.endSession(ended)
    const after = createDashboardAuth(time.now, fileSessionStore(dir))
    expect(after.hasSession(ended)).toBe(false)
    expect(after.hasSession(kept)).toBe(true)
    const path = join(dir, DASHBOARD_SESSIONS_FILE)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).not.toContain(kept)
  })

  test('a flushed lease survives a daemon restart until its own expiry, so an update does not close the dashboard', () => {
    const time = clock()
    const before = createDashboardAuth(time.now, fileSessionStore(dir))
    before.holdLease(LEASE, 'live')
    const session = before.redeemCode(before.issueCode(LEASE)!.code)!
    time.advance(5_000)
    before.holdLease(LEASE, 'live')
    before.flush()
    const after = createDashboardAuth(time.now, fileSessionStore(dir))
    expect(after.hasSession(session)).toBe(true)
    time.advance(LIVE_LEASE_TTL_MS)
    expect(after.hasSession(session)).toBe(false)
    after.holdLease(LEASE, 'live')
    expect(after.hasSession(session)).toBe(true)
  })

  test('a stop with nothing unwritten writes no file, so a stopped daemon does not recreate one uninstall removed', () => {
    const auth = createDashboardAuth(() => 1_000_000, fileSessionStore(dir))
    auth.flush()
    expect(existsSync(join(dir, DASHBOARD_SESSIONS_FILE))).toBe(false)
  })

  test('a released lease stays released after a restart', () => {
    const before = createDashboardAuth(() => 1_000_000, fileSessionStore(dir))
    before.holdLease(LEASE, 'live')
    const session = before.redeemCode(before.issueCode(LEASE)!.code)!
    before.releaseLease(LEASE)
    const after = createDashboardAuth(() => 1_000_000, fileSessionStore(dir))
    expect(after.isOpen()).toBe(false)
    after.holdLease(LEASE, 'live')
    expect(after.hasSession(session)).toBe(false)
  })

  test('a missing, damaged or oversized file starts with no sessions', () => {
    const path = join(dir, DASHBOARD_SESSIONS_FILE)
    for (const content of ['not json', '{"sessions":[["x","y"]]}', JSON.stringify({ sessions: [['0'.repeat(64), 2_000_000]], leases: [] }), JSON.stringify({ sessions: Array.from({ length: MAX_SESSIONS + 5 }, (_, i) => [String(i).padStart(64, '0'), 2_000_000]) })]) {
      writeFileSync(path, content)
      const auth = createDashboardAuth(() => 1_000_000, fileSessionStore(dir))
      expect(auth.hasSession('A'.repeat(43))).toBe(false)
    }
    expect(fileSessionStore(join(dir, 'missing')).load().sessions.size).toBe(0)
  })
})
