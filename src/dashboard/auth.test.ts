import { expect, test } from 'bun:test'
import { LOGIN_CODE_TTL_MS, MAX_LOGIN_CODES, SESSION_TTL_MS, createDashboardAuth, sessionCookie, sessionFromCookie } from './auth'

function clock(start: number = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return { now: () => at, advance: (ms) => { at += ms } }
}

test('a login code works once', () => {
  const auth = createDashboardAuth()
  const { code } = auth.issueCode()
  const session = auth.redeemCode(code)
  expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(auth.hasSession(session)).toBe(true)
  expect(auth.redeemCode(code)).toBeNull()
})

test('a login code expires after 60 s', () => {
  const time = clock()
  const auth = createDashboardAuth(time.now)
  const early = auth.issueCode()
  const late = auth.issueCode()
  time.advance(LOGIN_CODE_TTL_MS - 1)
  expect(auth.redeemCode(early.code)).not.toBeNull()
  time.advance(1)
  expect(auth.redeemCode(late.code)).toBeNull()
  expect(early.expiresInMs).toBe(60_000)
})

test('a wrong or malformed code is refused and burns nothing else', () => {
  const auth = createDashboardAuth()
  const { code } = auth.issueCode()
  const wrong = `${code.slice(0, -1)}${code.endsWith('A') ? 'B' : 'A'}`
  for (const attempt of [wrong, '', 'x', `${code}x`, code.toUpperCase() === code ? 'Z'.repeat(43) : code.toUpperCase()]) {
    expect(auth.redeemCode(attempt)).toBeNull()
  }
  expect(auth.redeemCode(code)).not.toBeNull()
})

test('sessions last 12 h, end on sign-out, and only the live secret counts', () => {
  const time = clock()
  const auth = createDashboardAuth(time.now)
  const session = auth.redeemCode(auth.issueCode().code)!
  const other = auth.redeemCode(auth.issueCode().code)!
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
  const codes = Array.from({ length: MAX_LOGIN_CODES + 1 }, () => auth.issueCode().code)
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
