import { expect, test } from 'bun:test'
import { claimFromHash, codeFromHash, signIn } from '../../../../dashboard/src/lib/login'

function deps(hash: string, status: number | Error) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  let forgotten = false
  return {
    calls,
    forgotten: () => forgotten,
    deps: {
      hash,
      forget: () => { forgotten = true },
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        if (status instanceof Error) throw status
        return new Response(null, { status })
      }),
    },
  }
}

test('a claim secret in the fragment is sent once to claim the sign-in the command offered, and leaves the address bar first', async () => {
  const run = deps('#claim=secret123', 204)
  expect(await signIn(run.deps)).toBe('signed-in')
  expect(run.forgotten()).toBe(true)
  expect(run.calls).toEqual([{ url: '/dashboard/claim', init: expect.objectContaining({ method: 'POST', body: JSON.stringify({ claim: 'secret123' }) }) }])
  expect(run.calls[0]!.init?.headers).toEqual({ 'content-type': 'application/json', 'x-sam-request': '1' })
})

test('the page at its plain address has nothing to trade, so it asks for nothing', async () => {
  const run = deps('', 204)
  expect(await signIn(run.deps)).toBe('how-to-open')
  expect(run.calls).toEqual([])
})

test('a code in the fragment is traded once for the session, and leaves the address bar first', async () => {
  const run = deps('#code=abc123', 204)
  expect(await signIn(run.deps)).toBe('signed-in')
  expect(run.forgotten()).toBe(true)
  expect(run.calls).toEqual([{ url: '/dashboard/session', init: expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: 'abc123' }) }) }])
})

test('closed, unclaimed, bad links and a silent daemon each say what to do', async () => {
  const closed = deps('#closed', 204)
  expect(await signIn(closed.deps)).toBe('closed')
  expect(closed.calls).toEqual([])
  expect(await signIn(deps('', 401).deps)).toBe('how-to-open')
  expect(await signIn(deps('#claim=used', 401).deps)).toBe('bad-link')
  expect(await signIn(deps('#claim=x', new TypeError('down')).deps)).toBe('no-answer')
  expect(claimFromHash('#claim=')).toBeNull()
  expect(await signIn(deps('#code=used', 401).deps)).toBe('bad-link')
  expect(await signIn(deps('#code=x', new TypeError('down')).deps)).toBe('no-answer')
  expect(codeFromHash('#code=')).toBeNull()
})
