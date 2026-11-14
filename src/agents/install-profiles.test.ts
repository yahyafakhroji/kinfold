import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { KNOWN_HOSTS } from '../contract/event'
import { parseHosts, parseObserverFlag } from '../install/args'
import { detectFromSpec, detectHosts } from '../install/detect'
import { type FakeWorld, createWorld } from '../install/test-support'
import { builtInSettings } from '../observer/settings'
import { INSTALL_PROFILES, hasWiring, isWired, profileOf } from './install-profiles'
import { type AgentId, capabilityLine } from './profile'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const LIVE = ['claude-code', 'opencode', 'codex', 'cursor'] as const
// In KNOWN_HOSTS order, which is the order detection lists them in.
const BUILT = [...LIVE, 'gemini-cli', 'qwen-code', 'factory-droid', 'devin', 'kilo-code', 'cline', 'copilot', 'antigravity', 'junie', 'kiro', 'amp', 'kimi-code', 'auggie', 'goose', 'crush', 'zed', 'continue', 'warp'] as const

describe('INSTALL_PROFILES', () => {
  test('INSTALL_PROFILES has exactly the KNOWN_HOSTS ids', () => {
    expect(Object.keys(INSTALL_PROFILES).sort()).toEqual([...KNOWN_HOSTS].sort())
  })

  test('each profile is keyed by its own id', () => {
    for (const id of KNOWN_HOSTS) expect(profileOf(id).id).toBe(id)
  })

  test('the four existing profiles are live and their capabilities match today', () => {
    for (const id of LIVE) expect(profileOf(id).verification).toBe('live')
    const line = (id: AgentId): string => capabilityLine(profileOf(id), 'macos')
    expect(line('claude-code')).toBe('captures, context at start and on each prompt, search')
    expect(line('codex')).toBe('captures, context at start and on each prompt, search')
    expect(line('cursor')).toBe('captures, context at start, search')
    expect(line('opencode')).toBe('captures, search')
  })
})

describe('detectFromSpec', () => {
  test('detectFromSpec finds a binary that answers, else an app bundle, and never counts a config folder', async () => {
    world = createWorld({ versionResults: { 'second-bin': { exitCode: 0, stdout: 'tool 1.2.3\nextra\n' } } })
    const spec = { binaries: ['first-bin', 'second-bin'], bundles: ['Tool.app'] }
    expect(await detectFromSpec(world.env, 'zed', spec, false)).toMatchObject({ host: 'zed', selected: true, version: 'tool 1.2.3', note: 'second-bin --version answered' })

    await world.cleanup()
    world = createWorld()
    mkdirSync(join(world.home, '.tool'))
    const none = await detectFromSpec(world.env, 'zed', spec, false)
    expect(none).toMatchObject({ selected: false, version: null, note: 'not found (no first-bin or second-bin on PATH, no Tool.app)' })

    mkdirSync(join(world.root, 'Applications', 'Tool.app', 'Contents'), { recursive: true })
    const app = await detectFromSpec(world.env, 'zed', spec, false)
    expect(app).toMatchObject({ selected: true, note: `${join(world.root, 'Applications', 'Tool.app')} exists` })
  })

  test('with no bundle the note names only the binaries, and --hosts still wires it', async () => {
    world = createWorld()
    const forced = await detectFromSpec(world.env, 'amp', { binaries: ['amp'] }, true)
    expect(forced).toMatchObject({ host: 'amp', selected: true, note: 'not found (no amp on PATH); wired because --hosts names it' })
  })

  test('a binary older than minVersion is refused even under --hosts', async () => {
    world = createWorld({ versionResults: { tool: { exitCode: 0, stdout: 'tool v0.9.1\n' } } })
    const old = await detectFromSpec(world.env, 'goose', { binaries: ['tool'], minVersion: [1, 0, 0] }, true)
    expect(old).toMatchObject({ selected: false, version: '0.9.1', note: 'tool 0.9.1 is not supported: Kinfold needs 1.0.0 or later' })
  })
})

describe('every agent has a profile', () => {
  test('detection lists them all, in KNOWN_HOSTS order', async () => {
    world = createWorld()
    expect((await detectHosts(world.env, null)).map((d) => d.host)).toEqual([...BUILT])
  })

  test('--hosts and --observer take the last three agents and refuse an unknown id', () => {
    expect(parseHosts('claude-code,zed,continue,warp')).toEqual({ ok: true, value: ['claude-code', 'zed', 'continue', 'warp'] })
    expect(parseObserverFlag('warp=openrouter:openrouter/auto').ok).toBe(true)
    const hosts = parseHosts('nonesuch')
    expect(hosts.ok).toBe(false)
  })

  test('a new agent with no saved settings defaults to OpenRouter auto', () => {
    for (const id of KNOWN_HOSTS.filter((host) => !(LIVE as readonly string[]).includes(host))) {
      expect(builtInSettings(id)).toMatchObject({ provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter' })
    }
  })
})

describe('profile modules', () => {
  test('every profile module can be imported first in a fresh process', () => {
    const dir = join(import.meta.dir, 'profiles')
    const files = [...new Bun.Glob('*.ts').scanSync(dir)].filter((file) => !file.endsWith('.test.ts')).sort()
    expect(files.length).toBeGreaterThanOrEqual(4)
    const table = join(import.meta.dir, 'install-profiles.ts')
    for (const file of files) {
      const script = `await import(${JSON.stringify(join(dir, file))}); const { INSTALL_PROFILES } = await import(${JSON.stringify(table)}); console.log(Object.keys(INSTALL_PROFILES).length)`
      const run = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
      expect({ file, exitCode: run.exitCode, stderr: run.stderr.toString() }).toEqual({ file, exitCode: 0, stderr: '' })
      expect(run.stdout.toString().trim()).toBe(String(KNOWN_HOSTS.length))
    }
  })
})

test('isWired counts wiring that is in place, current or not; hasWiring counts anything but none', () => {
  expect((['yes', 'stale', 'partial', 'no', 'unknown'] as const).map(isWired)).toEqual([true, true, true, false, false])
  // A config Kinfold cannot read may still hold its entries, so unknown keeps the agent's line.
  expect((['yes', 'stale', 'partial', 'no', 'unknown'] as const).map(hasWiring)).toEqual([true, true, true, false, true])
})
