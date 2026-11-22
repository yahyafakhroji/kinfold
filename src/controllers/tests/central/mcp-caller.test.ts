import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpToolCallerFor } from '../wsl/mcp-backend'
import { centralToolCaller } from './mcp-caller'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-mcp-central-'))
})
afterEach(() => {
  if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true })
})

const linux = { os: 'linux' as const, wsl: false, node: 'linux' as const }
const deviceRecord = { channel: 'curl', updateCheck: true, autoUpdate: true, firstInstalledAt: 1, central: { role: 'device', hub: 'mini', port: 37_812, hubName: 'mini', hubPublicKey: `${'A'.repeat(59)}=`, deviceId: 'dev-a', joinedAt: 1 } }

test('a central device reads through its daemon; a local or hub install reads its own store', () => {
  expect(mcpToolCallerFor({ dataDir: dir, cwd: '/w', platform: linux })).toBeNull()
  writeFileSync(join(dir, 'install.json'), JSON.stringify({ ...deviceRecord, central: { role: 'hub', port: 37_812 } }))
  expect(mcpToolCallerFor({ dataDir: dir, cwd: '/w', platform: linux })).toBeNull()
  writeFileSync(join(dir, 'install.json'), JSON.stringify(deviceRecord))
  expect(mcpToolCallerFor({ dataDir: dir, cwd: '/w', platform: linux })).not.toBeNull()
})

test('a tool call posts the arguments and cwd to the daemon with its token, and returns the outcome', async () => {
  writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ pid: process.pid, port: 40_001 }))
  writeFileSync(join(dir, 'daemon.token'), 't'.repeat(64))
  const seen: { url: string; init: RequestInit }[] = []
  const outcome = { result: { content: [{ type: 'text' as const, text: 'found' }], structuredContent: { rows: 1 } }, count: 1 }
  const call = centralToolCaller({ dataDir: dir, cwd: '/work/app', fetch: async (url, init) => {
    seen.push({ url, init })
    return Response.json({ outcome })
  } })
  expect(await call('search', { query: 'x' })).toEqual(outcome)
  expect(seen[0]!.url).toBe('http://127.0.0.1:40001/read/search')
  expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ args: { query: 'x' }, cwd: '/work/app' })
  expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${'t'.repeat(64)}`)
  expect(await call('purge', {})).toBeNull()
})

test('with the daemon down the answer says so, with no memory', async () => {
  const call = centralToolCaller({ dataDir: dir, cwd: '/w' })
  const outcome = await call('search', { query: 'x' })
  expect(outcome?.count).toBe(0)
  expect(outcome?.result.content[0]?.text).toBe('central memory is unavailable: the Kinfold daemon on this device is not running (kinfold status says why)')
  writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ pid: process.pid, port: 40_001 }))
  writeFileSync(join(dir, 'daemon.token'), 't'.repeat(64))
  const refused = centralToolCaller({ dataDir: dir, cwd: '/w', fetch: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) } })
  expect((await refused('search', {}))?.result.content[0]?.text).toBe('central memory is unavailable: the Kinfold daemon on this device is not running (kinfold status says why)')
  const broken = centralToolCaller({ dataDir: dir, cwd: '/w', fetch: async () => new Response('nope', { status: 500 }) })
  expect((await broken('search', {}))?.result.content[0]?.text).toBe('central memory is unavailable: the daemon on this device refused the read (HTTP 500)')
})
