// The server-wide body cap rose to the restore upload's ceiling, so the 16 KB
// limit every other route had from Bun is now the daemon's own to keep. These
// tests hold it: a large body is refused on every route, by its declared
// length or by counting, and no credential means no byte of body is read.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DashboardRig, startRig } from '../dashboard/test-support'
import { MAX_BODY_BYTES, MAX_UPLOAD_BYTES } from './server'

let root: string
let rig: DashboardRig

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kf-body-cap-'))
  rig = startRig(join(root, 'data'))
})
afterEach(async () => {
  await rig.stop()
  rmSync(root, { recursive: true, force: true })
})

const BIG = JSON.stringify({ pad: 'x'.repeat(17 * 1024) })

/** Every route that existed before the cap rose, with the method that reaches its handler. */
const ROUTES: readonly (readonly [method: string, path: string, reads: boolean])[] = [
  ['PUT', '/observer/settings', true],
  ['POST', '/observer/recheck', true],
  ['POST', '/observer/retry', true],
  ['POST', '/search/semantic', true],
  ['POST', '/context', true],
  ['POST', '/metrics/mcp-read', true],
  ['PUT', '/data/retention', true],
  ['POST', '/data/purge', true],
  ['POST', '/data/findings/1/resolve', true],
  ['POST', '/read/search', true],
  ['POST', '/read/timeline', true],
  ['POST', '/read/get_observations', true],
  ['POST', '/restore', true],
  // Answers 503 unread in a daemon with no observer, as this rig's is.
  ['POST', '/observer/test', false],
  ['POST', '/spool/nudge', false],
  ['POST', '/data/scan', false],
  ['POST', '/dashboard/login-code', false],
  ['GET', '/sessions', false],
  ['GET', '/update', false],
]

/** A body with no declared length: chunks of 1 KB until `total` bytes went, or forever. */
function chunked(total: number | null): { body: ReadableStream<Uint8Array>; sent: () => number } {
  let sent = 0
  const chunk = new Uint8Array(1024).fill(0x78)
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (total !== null && sent >= total) {
        controller.close()
        return
      }
      await Bun.sleep(1)
      controller.enqueue(chunk)
      sent += chunk.length
    },
  })
  return { body, sent: () => sent }
}

test('the server takes bodies up to the upload ceiling, far above the per-route cap', () => {
  expect(MAX_BODY_BYTES).toBe(16_384)
  expect(MAX_UPLOAD_BYTES).toBeGreaterThan(1024 ** 3)
})

test('every existing route refuses a 17 KB body', async () => {
  for (const [method, path] of ROUTES) {
    if (method === 'GET') continue
    const response = await fetch(rig.url(path), { method, headers: { authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' }, body: BIG })
    expect(`${method} ${path} ${response.status}`).toBe(`${method} ${path} 413`)
    expect(await response.json()).toEqual({ error: 'body too large' })
  }
  const session = await fetch(rig.url('/dashboard/session'), { method: 'POST', headers: { origin: rig.origin, 'x-sam-request': '1', 'content-type': 'application/json' }, body: BIG })
  expect(session.status).toBe(413)
})

test('a 17 KB body with no declared length is refused by count on every route that reads one', async () => {
  for (const [method, path, reads] of ROUTES) {
    if (!reads) continue
    const { body } = chunked(17 * 1024)
    const response = await fetch(rig.url(path), { method, headers: { authorization: `Bearer ${rig.token}` }, body })
    expect(`${method} ${path} ${response.status}`).toBe(`${method} ${path} 400`)
    expect(await response.json()).toEqual({ error: 'body too large' })
  }
})

test('a body at the cap still gets through to the parser', async () => {
  const body = JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES - 10) })
  expect(Buffer.byteLength(body)).toBe(MAX_BODY_BYTES)
  const response = await fetch(rig.url('/observer/retry'), { method: 'POST', headers: { authorization: `Bearer ${rig.token}` }, body })
  expect(response.status).toBe(400)
  expect(((await response.json()) as { error: string }).error).not.toBe('body too large')
})

test('a body that never ends is answered once the cap is passed, not buffered', async () => {
  const stream = chunked(null)
  const controller = new AbortController()
  const response = await fetch(rig.url('/context'), { method: 'POST', headers: { authorization: `Bearer ${rig.token}` }, body: stream.body, signal: controller.signal })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'body too large' })
  // The answer came after little more than the cap, while the client was still sending.
  expect(stream.sent()).toBeLessThan(MAX_BODY_BYTES * 8)
  controller.abort()
})

test('a route that reads no body answers a never-ending one at once', async () => {
  const stream = chunked(null)
  const controller = new AbortController()
  const response = await fetch(rig.url('/spool/nudge'), { method: 'POST', headers: { authorization: `Bearer ${rig.token}` }, body: stream.body, signal: controller.signal })
  expect(response.status).toBe(202)
  expect(stream.sent()).toBeLessThan(MAX_BODY_BYTES * 8)
  controller.abort()
})

test('no credential or a foreign Host is refused before any body is read, the upload route included', async () => {
  for (const path of ['/restore/upload', '/restore', '/context', '/data/purge']) {
    for (const headers of [{}, { authorization: `Bearer ${'0'.repeat(64)}` }, { authorization: `Bearer ${rig.token}`, host: 'evil.example:80' }] as Record<string, string>[]) {
      const stream = chunked(null)
      const controller = new AbortController()
      const response = await fetch(rig.url(path), { method: 'POST', headers, body: stream.body, signal: controller.signal })
      expect(response.status).toBe('host' in headers ? 403 : 401)
      expect(stream.sent()).toBeLessThan(MAX_BODY_BYTES * 8)
      controller.abort()
    }
  }
})

test('a cookie request from another origin is refused before the upload is read', async () => {
  const cookie = await rig.login()
  const stream = chunked(null)
  const controller = new AbortController()
  const response = await fetch(rig.url('/restore/upload'), { method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: stream.body, signal: controller.signal })
  expect(response.status).toBe(403)
  controller.abort()
})
