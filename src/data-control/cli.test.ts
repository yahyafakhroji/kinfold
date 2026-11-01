import { afterEach, beforeEach, expect, test } from 'bun:test'
import { runSam } from '../cli/sam'
import { startDaemon } from '../daemon/daemon'
import { parseArgs, parseDataArgs } from '../install/args'
import { EXIT_USAGE } from '../install/install'
import { type FakeWorld, createWorld } from '../install/test-support'
import { planFor } from './cli'

let world: FakeWorld
beforeEach(() => {
  world = createWorld()
})
afterEach(async () => world.cleanup())

function startWorldDaemon(): void {
  const daemon = startDaemon({ dataDir: world.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  world.launchd.daemon = daemon
  world.allowedPorts.add(daemon.port)
}

const parsed = (argv: string[]) => {
  const result = parseDataArgs(argv)
  if (result === null || !result.ok) throw new Error(`did not parse: ${result === null ? 'not a data command' : result.error}`)
  return result.value
}
const errorOf = (argv: string[]): string => {
  const result = parseDataArgs(argv)
  return result === null ? 'not a data command' : result.ok ? 'parsed' : result.error
}

test('each data subcommand parses and maps to its route', () => {
  const routes = (argv: string[]) => {
    const plan = planFor(parsed(argv))
    return [plan.method, plan.path, plan.body]
  }
  expect(routes(['size'])).toEqual(['GET', '/data/size', undefined])
  expect(routes(['scan'])).toEqual(['POST', '/data/scan', {}])
  expect(routes(['retention'])).toEqual(['GET', '/data/retention', undefined])
  expect(routes(['retention', '--set', 'events=7', '--set=prompts=keep', '--set', 'warn_bytes=1000'])).toEqual(['PUT', '/data/retention', { retention: { events: 7, prompts: null }, warnBytes: 1000, preview: true }])
  expect(routes(['retention', '--set', 'events=7', '--yes'])).toEqual(['PUT', '/data/retention', { retention: { events: 7 } }])
  expect(routes(['findings'])).toEqual(['GET', '/data/findings?action=pending', undefined])
  expect(routes(['findings', '--all'])).toEqual(['GET', '/data/findings?action=all', undefined])
  expect(routes(['findings', '--redact', '4'])).toEqual(['POST', '/data/findings/4/resolve', { action: 'redact' }])
  expect(routes(['findings', '--purge=5'])).toEqual(['POST', '/data/findings/5/resolve', { action: 'purge' }])
  expect(routes(['purge', '--session', '3', '--dry-run'])).toEqual(['POST', '/data/purge', { session: 3, dryRun: true }])
  expect(routes(['purge', '--project', 'org/repo'])).toEqual(['POST', '/data/purge', { project: 'org/repo' }])
  expect(routes(['purge', '--host', 'opencode'])).toEqual(['POST', '/data/purge', { host: 'opencode' }])
  expect(routes(['purge', '--observation', '9'])).toEqual(['POST', '/data/purge', { observation: 9 }])
  expect(routes(['purge', '--before', '2026-10-01T00:00:00Z', '--after', '2026-09-01'])).toEqual(['POST', '/data/purge', { before: '2026-10-01T00:00:00Z', after: '2026-09-01' }])
})

test('bad data flags are usage errors, and install/uninstall/status still parse as before', () => {
  expect(errorOf(['purge'])).toStartWith('purge: name exactly one of')
  expect(errorOf(['purge', '--session', '1', '--host', 'x'])).toStartWith('purge: name exactly one of')
  expect(errorOf(['purge', '--session', 'abc'])).toBe('purge: session must be a positive integer id')
  expect(errorOf(['purge', '--before', 'yesterday'])).toBe('purge: before must be epoch ms or an ISO 8601 time')
  expect(errorOf(['purge', '--session'])).toBe('--session needs a value')
  expect(errorOf(['purge', '--force', '1'])).toStartWith('unknown purge flag "--force"')
  expect(errorOf(['retention', '--set', 'events=0'])).toStartWith('retention.events must be whole days')
  expect(errorOf(['retention', '--set', 'vectors=3'])).toStartWith('retention tables are')
  expect(errorOf(['retention', '--set', 'events'])).toStartWith('retention takes --set')
  expect(errorOf(['retention', '--yes'])).toBe('retention --yes needs at least one --set')
  expect(errorOf(['retention', '--yes=1'])).toStartWith('retention takes --set')
  expect(errorOf(['findings', '--redact', '1', '--purge', '2'])).toBe('resolve one finding at a time')
  expect(errorOf(['size', '--all'])).toBe('size takes no flags')
  expect(errorOf(['scan', 'now'])).toBe('scan takes no flags')
  expect(errorOf(['findings', 'all'])).toStartWith('unknown argument "all"')
  expect(errorOf(['status'])).toBe('not a data command')
  expect(parseArgs(['status']).ok).toBe(true)
  expect(parseArgs(['size'])).toEqual({ ok: false, error: expect.stringContaining('usage: bun src/cli/sam.ts <install|uninstall|status|size|') })
})

test('runSam sends each data command to the running daemon and prints its answer', async () => {
  startWorldDaemon()
  for (const argv of [['size'], ['retention'], ['retention', '--set', 'events=14'], ['scan'], ['findings'], ['purge', '--host', 'nobody', '--dry-run']]) {
    expect(await runSam(argv, world.env)).toBe(0)
  }
  expect(world.fetches).toEqual(['GET /data/size', 'GET /data/retention', 'PUT /data/retention', 'POST /data/scan', 'GET /data/findings', 'POST /data/purge'])
  expect(world.out).toContain('retention: events 14 days (payload), prompts keep (text), observations keep, summaries keep')
  expect(world.out).toContain('preview, nothing saved; saving now would expire: events 0 (0 B), prompts 0 (0 B), observations 0 (0 B), summaries 0 (0 B)')
  expect(world.out).toContain('dry run, nothing changed; would remove: nothing')
  expect(world.out.some((line) => line.startsWith('scanned 0 rows'))).toBe(true)
  expect(world.out.some((line) => line.startsWith('database '))).toBe(true)
})

test('a data command without a daemon fails with exit 1, and a usage error exits 2 without a request', async () => {
  expect(await runSam(['size'], world.env)).toBe(1)
  expect(world.out.at(-1)).toBe('sam size failed: the daemon is not running (no daemon.json or daemon.token)')
  expect(await runSam(['purge'], world.env)).toBe(EXIT_USAGE)
  expect(world.fetches).toEqual([])
  startWorldDaemon()
  expect(await runSam(['findings', '--redact', '77'], world.env)).toBe(1)
  expect(world.out.at(-1)).toBe('sam findings failed: POST /data/findings/77/resolve answered 404: no such finding')
})

test('sam retention previews a change and saves only with --yes', async () => {
  startWorldDaemon()
  expect(await runSam(['retention', '--set', 'prompts=3'], world.env)).toBe(0)
  expect(world.out.at(-1)).toBe('run again with --yes to save and apply')
  world.out.length = 0
  expect(await runSam(['retention'], world.env)).toBe(0)
  expect(world.out[0]).toContain('prompts keep (text)')
  expect(await runSam(['retention', '--set', 'prompts=3', '--yes'], world.env)).toBe(0)
  expect(world.out.at(-1)).toBe('applied now: events 0, prompts 0, observations 0, summaries 0')
  world.out.length = 0
  expect(await runSam(['retention'], world.env)).toBe(0)
  expect(world.out[0]).toContain('prompts 3 days (text)')
})
