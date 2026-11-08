import { expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { downloadPinned } from './pinned-download'

const GOOD = new TextEncoder().encode('the real file')
const sha = createHash('sha256').update(GOOD).digest('hex')
const RELEASE = 'https://example.test/release.zip'
const API = 'https://example.test/api/asset'

type Reply = Response | Error
function fakeFetch(replies: Record<string, Reply>) {
  const calls: { url: string; accept: string | null }[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, accept: new Headers(init?.headers).get('accept') })
    const reply = replies[url]
    if (reply instanceof Error) throw reply
    return reply
  }) as unknown as typeof fetch
  return { impl, calls }
}
const download = (impl: typeof fetch, token?: string) => downloadPinned({ label: 'test asset', releaseUrl: RELEASE, apiUrl: API, sha256: sha, maxBytes: 1000, fetch: impl, token })

test('takes the release URL when it answers', async () => {
  const { impl, calls } = fakeFetch({ [RELEASE]: new Response(GOOD) })
  expect(await download(impl)).toEqual(GOOD)
  expect(calls.map((c) => c.url)).toEqual([RELEASE])
})

test('falls back to the API asset URL on a 504 and accepts the right bytes', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const { impl, calls } = fakeFetch({ [RELEASE]: new Response('', { status: 504 }), [API]: new Response(GOOD) })
  expect(await download(impl)).toEqual(GOOD)
  expect(calls.map((c) => c.url)).toEqual([RELEASE, API])
  expect(calls[1]?.accept).toBe('application/octet-stream')
  warn.mockRestore()
})

test('falls back after a timeout', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const { impl } = fakeFetch({ [RELEASE]: new DOMException('timed out', 'TimeoutError'), [API]: new Response(GOOD) })
  expect(await download(impl)).toEqual(GOOD)
  warn.mockRestore()
})

test('rejects wrong bytes from the API asset URL', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const { impl } = fakeFetch({ [RELEASE]: new Response('', { status: 504 }), [API]: new Response('tampered') })
  await expect(download(impl)).rejects.toThrow('does not match the pinned sha256')
  warn.mockRestore()
})

test('does not fall back when the release URL serves wrong bytes', async () => {
  const { impl, calls } = fakeFetch({ [RELEASE]: new Response('tampered'), [API]: new Response(GOOD) })
  await expect(download(impl)).rejects.toThrow('does not match the pinned sha256')
  expect(calls.map((c) => c.url)).toEqual([RELEASE])
})

test('does not fall back on a 404', async () => {
  const { impl, calls } = fakeFetch({ [RELEASE]: new Response('', { status: 404 }), [API]: new Response(GOOD) })
  await expect(download(impl)).rejects.toThrow('answered 404')
  expect(calls).toHaveLength(1)
})

test('names both failures when both URLs fail', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const { impl } = fakeFetch({ [RELEASE]: new Response('', { status: 504 }), [API]: new Response('', { status: 502 }) })
  await expect(download(impl)).rejects.toThrow('failed on both URLs (release URL answered 504; API asset URL answered 502)')
  warn.mockRestore()
})

test('rejects an oversized download', async () => {
  const { impl } = fakeFetch({ [RELEASE]: new Response(new Uint8Array(2000)) })
  await expect(download(impl)).rejects.toThrow('far larger')
})

test('sends the token to the API asset URL and never to the release URL', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const auth: (string | null)[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get('authorization'))
    return url === RELEASE ? new Response('', { status: 504 }) : new Response(GOOD)
  }) as unknown as typeof fetch
  await download(impl, 'tok')
  expect(auth).toEqual([null, 'Bearer tok'])
  warn.mockRestore()
})
