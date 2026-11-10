import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLinuxPlatform, smokePlatform } from './linux'
import type { LinuxSmokeDeps } from './linux'
import { SmokeError } from './platform'
import type { SmokePlatform, SmokeResult, SmokeWorld } from './platform'

const SCRIPT = readFileSync(join(import.meta.dir, '..', '..', '.github', 'smoke', 'linux.sh'), 'utf8')
const X64_SHA = '08bb21d6326ce740d91cce7ebe88a6536933f6e1e30353b91a06b01f25da306c'
const ARM64_SHA = 'f2d27600c367e45057d6a16f6a5c2aa8d77b41a9b10d4bc3d849c2f88870e944'
const KEY_STORE_MESSAGE = 'KINFOLD_SMOKE_KEY_STORE must be libsecret or key file; .github/smoke/linux.sh setup sets it'
const SERVICE_MESSAGE = 'KINFOLD_SMOKE_SERVICE must be systemd or foreground; .github/smoke/linux.sh setup sets it'

const savedEnv = { store: process.env.KINFOLD_SMOKE_KEY_STORE, service: process.env.KINFOLD_SMOKE_SERVICE }
const roots: string[] = []

afterEach(() => {
  for (const [key, value] of [['KINFOLD_SMOKE_KEY_STORE', savedEnv.store], ['KINFOLD_SMOKE_SERVICE', savedEnv.service]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function caught(read: () => unknown): unknown {
  try {
    read()
  } catch (error: unknown) {
    return error
  }
  return null
}

function expectSetupError(error: unknown, message: string): void {
  expect(error).toBeInstanceOf(SmokeError)
  expect((error as SmokeError).step).toBe('setup')
  expect((error as SmokeError).message).toBe(message)
}

let freshLoads = 0
async function freshPlatform(service: string | undefined): Promise<SmokePlatform> {
  if (service === undefined) delete process.env.KINFOLD_SMOKE_SERVICE
  else process.env.KINFOLD_SMOKE_SERVICE = service
  freshLoads += 1
  const loaded = await import(`./linux.ts?fresh=${freshLoads}`) as { smokePlatform: SmokePlatform }
  return loaded.smokePlatform
}

function world(): SmokeWorld {
  const root = mkdtempSync(join(tmpdir(), 'kinfold-linux-smoke-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return {
    program: join(root, 'kinfold'),
    root,
    home,
    project: root,
    dataDir: join(home, '.kinfold'),
    fakeBin: join(root, 'bin'),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
    marker: 'smokeeventtest',
  }
}

function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = server.port
  server.stop(true)
  return port
}

function portIsFree(port: number): boolean {
  try {
    Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true)
    return true
  } catch {
    return false
  }
}

describe('the Linux smoke platform', () => {
  test('the Linux steps name the systemd unit', () => {
    expect(smokePlatform.name).toBe('linux')
    expect(smokePlatform.programName).toBe('kinfold')
    expect(smokePlatform.serviceFiles('/h')).toEqual(['/h/.config/systemd/user/kinfold.service'])
  })

  test('the key store label comes from the setup step', () => {
    process.env.KINFOLD_SMOKE_KEY_STORE = 'libsecret'
    expect(smokePlatform.keyStoreLabel).toBe('libsecret')
    process.env.KINFOLD_SMOKE_KEY_STORE = 'key file'
    expect(smokePlatform.keyStoreLabel).toBe('key file')
    process.env.KINFOLD_SMOKE_KEY_STORE = 'vault'
    expectSetupError(caught(() => smokePlatform.keyStoreLabel), KEY_STORE_MESSAGE)
    delete process.env.KINFOLD_SMOKE_KEY_STORE
    expectSetupError(caught(() => smokePlatform.keyStoreLabel), KEY_STORE_MESSAGE)
  })

  test('the foreground daemon is offered only without a user manager', async () => {
    expect((await freshPlatform('systemd')).foregroundDaemon).toBeUndefined()
    expect(typeof (await freshPlatform('foreground')).foregroundDaemon).toBe('function')
    const other = await freshPlatform('x')
    expectSetupError(caught(() => other.foregroundDaemon), SERVICE_MESSAGE)
  })

  test('importing the Linux steps never throws without the setup variables', async () => {
    const platform = await freshPlatform(undefined)
    expect(platform.programName).toBe('kinfold')
    expectSetupError(caught(() => platform.foregroundDaemon), SERVICE_MESSAGE)
  })

  test.if(process.platform === 'linux' || process.platform === 'darwin')('a foreground daemon stops when asked', async () => {
    const platform = await freshPlatform('foreground')
    const port = freePort()
    const base = world()
    const w: SmokeWorld = { ...base, env: { ...base.env, KINFOLD_PORT: String(port) } }
    const bin = join(w.dataDir, 'bin')
    mkdirSync(bin, { recursive: true })
    const server = "Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.KINFOLD_PORT), fetch: (r) => new URL(r.url).pathname === '/health' ? Response.json({ ok: true }) : new Response('', { status: 404 }) })"
    const program = join(bin, 'kinfold')
    writeFileSync(program, `#!/bin/sh\nexec '${process.execPath}' -e "${server}"\n`)
    chmodSync(program, 0o755)
    const start = platform.foregroundDaemon
    if (start === undefined) throw new Error('no foreground daemon')
    const handle = await start(w)
    expect(portIsFree(port)).toBe(false)
    await handle.stop()
    expect(portIsFree(port)).toBe(true)
  }, 30_000)
})

describe('the status check before the first conversion', () => {
  const statusOutput = [
    'service (systemd user service): config present; running: yes',
    'daemon /health: up on 127.0.0.1:37811 version 0.1.0 schema 9 pid 42, systemd user service',
    'database: encrypted (libsecret db-key present)',
    'key store: libsecret (recorded in key-store.json)',
    'warning: LUKS is off; the spool, logs and agent transcripts are unencrypted on disk. LUKS is set up when a disk is formatted',
  ].join('\n')

  function deps(overrides: Partial<LinuxSmokeDeps> = {}): { deps: LinuxSmokeDeps; calls: string[] } {
    const calls: string[] = []
    const ok = (stdout: string): SmokeResult => ({ code: 0, stdout, stderr: '' })
    return {
      calls,
      deps: {
        env: { KINFOLD_SMOKE_SERVICE: 'systemd', KINFOLD_SMOKE_KEY_STORE: 'libsecret' },
        status: async () => { calls.push('status'); return ok(statusOutput) },
        verifyUnit: async (_world, unit) => { calls.push(`verify ${unit}`); return ok('') },
        runPty: async (_world, operation) => { calls.push(operation); return ok('') },
        ...overrides,
      },
    }
  }

  test('checks status and the unit once, then hands every conversion to the pty run', async () => {
    const { deps: d, calls } = deps()
    const platform = createLinuxPlatform(d)
    const w = world()
    await platform.runConversion?.(w, 'decrypt')
    await platform.runConversion?.(w, 'encrypt')
    expect(calls).toEqual(['status', `verify ${w.home}/.config/systemd/user/kinfold.service`, 'decrypt', 'encrypt'])
  })

  test('a missing status line stops the run before any conversion', async () => {
    for (const missing of ['key store:', 'service (', 'LUKS']) {
      const output = statusOutput.split('\n').filter((line) => !line.includes(missing)).join('\n')
      const { deps: d, calls } = deps({ status: async () => ({ code: 0, stdout: output, stderr: '' }) })
      const error = await createLinuxPlatform(d).runConversion?.(world(), 'decrypt').catch((e: unknown) => e)
      expect(error).toBeInstanceOf(SmokeError)
      expect((error as SmokeError).step).toBe('status')
      expect(calls).not.toContain('decrypt')
    }
  })

  test('a unit systemd-analyze rejects stops the run', async () => {
    const { deps: d, calls } = deps({ verifyUnit: async () => ({ code: 1, stdout: '', stderr: 'kinfold.service: bad setting' }) })
    const error = await createLinuxPlatform(d).runConversion?.(world(), 'decrypt').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SmokeError)
    expect((error as SmokeError).step).toBe('unit')
    expect(calls).not.toContain('decrypt')
  })

  test('a warning about kinfold.service stops the run even when verify exits 0', async () => {
    const { deps: d } = deps({ verifyUnit: async () => ({ code: 0, stdout: '', stderr: '/h/.config/systemd/user/kinfold.service:7: Unknown key' }) })
    const error = await createLinuxPlatform(d).runConversion?.(world(), 'decrypt').catch((e: unknown) => e)
    expect((error as SmokeError).step).toBe('unit')
  })

  test('the foreground run expects the service not running and skips the unit check', async () => {
    const foregroundStatus = statusOutput.replace('config present; running: yes', 'config missing; running: no')
    const calls: string[] = []
    const { deps: d } = deps({
      env: { KINFOLD_SMOKE_SERVICE: 'foreground', KINFOLD_SMOKE_KEY_STORE: 'libsecret' },
      status: async () => { calls.push('status'); return { code: 0, stdout: foregroundStatus, stderr: '' } },
      verifyUnit: async () => { calls.push('verify'); return { code: 0, stdout: '', stderr: '' } },
      runPty: async (_world, operation) => { calls.push(operation); return { code: 0, stdout: '', stderr: '' } },
    })
    await createLinuxPlatform(d).runConversion?.(world(), 'decrypt')
    expect(calls).toEqual(['status', 'decrypt'])
  })
})

describe('linux.sh', () => {
  test('linux.sh has a setup and a cleanup and pins OpenCode', () => {
    expect(SCRIPT).toContain('setup)')
    expect(SCRIPT).toContain('cleanup)')
    expect(SCRIPT).toContain(X64_SHA)
    expect(SCRIPT).toContain(ARM64_SHA)
    expect(SCRIPT).toContain('set -euo pipefail')
  })

  test('sudo in linux.sh only installs packages and sets linger', () => {
    const lines = SCRIPT.split('\n').filter((line) => line.includes('sudo '))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).toMatch(/sudo (apt-get (update|install)|loginctl (enable|disable)-linger)\b/)
  })

  test('the arm64 smoke runs without a session bus', () => {
    const blocks = [...SCRIPT.matchAll(/^\s*ARM64\)([\s\S]*?);;/gm)].map((match) => match[1] ?? '')
    const store = blocks.find((block) => block.includes('KINFOLD_SMOKE_KEY_STORE'))
    expect(store).toBeDefined()
    expect(store).toMatch(/DBUS_SESSION_BUS_ADDRESS=["']?$/m)
    expect(store).toContain('KINFOLD_SMOKE_KEY_STORE=key file')
  })

  test('the live libsecret test runs without the sqlite3mc build the smoke never makes', () => {
    const line = SCRIPT.split('\n').find((text) => text.includes('libsecret.live.test.ts'))
    expect(line).toBeDefined()
    expect(line).toContain('KINFOLD_SQLITE3MC_LIB=/nonexistent')
    expect(line).toContain('KINFOLD_TEST_SECRET_SERVICE=1')
  })

  test('the OpenCode archive is checked before it is extracted', () => {
    const check = SCRIPT.indexOf('sha256sum --check')
    const extract = SCRIPT.indexOf('tar -x')
    expect(check).toBeGreaterThan(0)
    expect(extract).toBeGreaterThan(check)
  })
})
