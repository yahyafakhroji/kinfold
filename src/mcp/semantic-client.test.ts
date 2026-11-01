import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAEMON_INFO_FILE, TOKEN_FILE } from '../store/data-dir'
import { createSemanticClient, parseSemanticAnswer } from './semantic-client'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sam-semclient-'))
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const QUERY = { query: 'parser quotes', project: 'p', k: 5, filters: { type: null, host: null, evidence: null } }
const daemonUp = () => {
  writeFileSync(join(dataDir, DAEMON_INFO_FILE), JSON.stringify({ pid: 1, port: 40_123 }))
  writeFileSync(join(dataDir, TOKEN_FILE), 'tok')
}

test('no daemon: unavailable, and nothing is sent', async () => {
  let calls = 0
  const client = createSemanticClient({ dataDir, fetch: async () => (calls += 1, new Response('{}')) })
  expect(await client(QUERY)).toEqual({ status: 'unavailable', reason: 'the daemon is not running' })
  expect(calls).toBe(0)
})

test('the query goes to /search/semantic with the token and a deadline under the client timeout', async () => {
  daemonUp()
  const seen: { url: string; init: RequestInit }[] = []
  const client = createSemanticClient({ dataDir, timeoutMs: 1_000, fetch: async (url, init) => {
    seen.push({ url, init })
    return new Response(JSON.stringify({ status: 'ok', hits: [{ id: 3, distance: 0.25 }], embedMs: 9, searchMs: 1, cached: false }))
  } })
  expect(await client(QUERY)).toEqual({ status: 'ok', hits: [{ id: 3, distance: 0.25 }], embedMs: 9, searchMs: 1, cached: false })
  expect(seen[0]!.url).toBe('http://127.0.0.1:40123/search/semantic')
  expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok')
  expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ ...QUERY, deadlineMs: 850 })
})

test('a refusal, a network error and a slow daemon never throw', async () => {
  daemonUp()
  expect(await createSemanticClient({ dataDir, fetch: async () => new Response('{}', { status: 401 }) })(QUERY)).toEqual({ status: 'unavailable', reason: 'the daemon answered 401' })
  expect(await createSemanticClient({ dataDir, fetch: async () => { throw new TypeError('refused') } })(QUERY)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('TypeError') })
  const slow = createSemanticClient({ dataDir, timeoutMs: 5, fetch: (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))) })
  expect(await slow(QUERY)).toEqual({ status: 'timeout', ms: 5 })
})

test('only known answer shapes pass; hits must be ids and finite distances', () => {
  expect(parseSemanticAnswer({ status: 'ok', hits: [{ id: 'x', distance: 1 }] })).toMatchObject({ status: 'unavailable' })
  expect(parseSemanticAnswer({ status: 'ok', hits: [{ id: 1, distance: null }] })).toMatchObject({ status: 'unavailable' })
  expect(parseSemanticAnswer({ status: 'unavailable', reason: 'r'.repeat(400) })).toEqual({ status: 'unavailable', reason: 'r'.repeat(300) })
  expect(parseSemanticAnswer('nope')).toMatchObject({ status: 'unavailable' })
})
