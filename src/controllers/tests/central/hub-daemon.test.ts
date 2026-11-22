import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHubWhenReady } from './hub-daemon'
import type { CentralCore } from './hub-routes'
import { TAILSCALE_STOPPED, type Tailscale, type TailscaleProblem, type TailscaleSelf } from './tailscale'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-hub-daemon-'))
})
afterEach(() => {
  if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true })
})

const SELF: TailscaleSelf = { identity: { userId: '42', loginName: '', nodeId: 'nHUB', nodeName: 'mini', tags: [] }, addresses: ['127.0.0.1'], dnsName: 'mini.tail.ts.net' }
const core = (): CentralCore => { throw new Error('not used') }

test('the hub waits for Tailscale, then binds and answers', async () => {
  let self: TailscaleSelf | TailscaleProblem = { problem: TAILSCALE_STOPPED }
  const logs: string[] = []
  const tailscale: Tailscale = { self: async () => self, whois: async () => null }
  const hub = startHubWhenReady({ dataDir: dir, version: '0.6.0', port: 0, tailscale, core, view: async () => ({ status: 200, body: {} }), log: (line) => logs.push(line), allowLoopback: true, retryMs: 20 })
  try {
    await Bun.sleep(5)
    expect(hub.state()).toMatchObject({ listening: null, error: 'Tailscale is not running or not signed in on this machine' })
    self = SELF
    await hub.ready
    const listening = hub.state().listening!
    expect(listening).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(hub.state().hubName).toBe('mini')
    const response = await fetch(`http://${listening}/central/hello`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(401)
    // The retry logs once, not on every attempt.
    expect(logs.filter((line) => line.startsWith('central hub not listening')).length).toBe(1)
    if (process.platform !== 'win32') expect(statSync(join(dir, 'central', 'hub-key.pem')).mode & 0o777).toBe(0o600)
  } finally {
    await hub.stop()
  }
})

test('a tagged hub, or one with no Tailscale address, never listens', async () => {
  const tagged = startHubWhenReady({ dataDir: dir, version: '0.6.0', port: 0, tailscale: { self: async () => ({ ...SELF, identity: { ...SELF.identity, tags: ['tag:server'] } }), whois: async () => null }, core, view: async () => ({ status: 200, body: {} }), log: () => {}, allowLoopback: true, retryMs: 1_000 })
  const noAddress = startHubWhenReady({ dataDir: dir, version: '0.6.0', port: 0, tailscale: { self: async () => ({ ...SELF, addresses: ['192.168.1.5'] }), whois: async () => null }, core, view: async () => ({ status: 200, body: {} }), log: () => {}, retryMs: 1_000 })
  await Bun.sleep(20)
  expect(tagged.state()).toMatchObject({ listening: null })
  expect(tagged.state().error).toContain('tagged')
  expect(noAddress.state()).toMatchObject({ listening: null })
  expect(noAddress.state().error).toContain('Tailscale address')
  await tagged.stop()
  await noAddress.stop()
})
