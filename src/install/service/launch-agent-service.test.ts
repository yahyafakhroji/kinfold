import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { envName } from '../../env-names'
import { DB_KEY_REF } from '../../secrets/credentials'
import { installPaths } from '../env'
import { bootoutArgv, bootstrapArgv, LAUNCHCTL, plistContent } from '../launch-agent'
import { BOOTSTRAP_ATTEMPTS } from '../plan'
import { type FakeWorld, UID, createWorld } from '../test-support'
import { serviceFor } from './control'
import { LaunchAgentService, LSOF, PS } from './launch-agent-service'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

/** A world whose Keychain holds the database key, so the fake bootstrap's daemon can open a new store. */
function keyedWorld(): FakeWorld {
  const w = createWorld({ keychainRefs: [DB_KEY_REF] })
  w.keychainValues.set(DB_KEY_REF, 'a'.repeat(64))
  return w
}

function writePlist(w: FakeWorld, content: string): void {
  const path = installPaths(w.env).launchAgentPlist
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

test('the LaunchAgent service runs bootout and bootstrap', async () => {
  world = keyedWorld()
  const w = world
  const service = new LaunchAgentService(w.env)
  await service.start()
  expect(await service.isRunning()).toBe(true)
  await service.stop()
  expect(w.launchd.loaded).toBe(false)
  const argvs = w.commands.map((c) => [...c.argv])
  expect(argvs).toContainEqual([LAUNCHCTL, 'bootout', `gui/${UID}/dev.kinfold.daemon`])
  expect(argvs).toContainEqual(bootstrapArgv(w.env))
  expect(argvs).toContainEqual(bootoutArgv(UID))
})

test('start retries the busy exit up to BOOTSTRAP_ATTEMPTS times and then reports it', async () => {
  world = keyedWorld()
  const w = world
  w.launchd.busy = BOOTSTRAP_ATTEMPTS - 1
  await new LaunchAgentService(w.env).start()
  expect(w.commands.filter((c) => c.argv[1] === 'bootstrap')).toHaveLength(BOOTSTRAP_ATTEMPTS)

  world = keyedWorld()
  const stuck = world
  stuck.launchd.busy = 1_000
  await expect(new LaunchAgentService(stuck.env).start()).rejects.toThrow('bootstrap failed (exit 5)')
  expect(stuck.commands.filter((c) => c.argv[1] === 'bootstrap')).toHaveLength(BOOTSTRAP_ATTEMPTS)
})

test('stop fails when launchd still has the job after the wait', async () => {
  world = createWorld()
  const w = world
  const env = { ...w.env, run: async (request: { argv: readonly string[] }) => (w.commands.push(request), { exitCode: request.argv[1] === 'print' ? 0 : 1, stdout: '' }) }
  await expect(new LaunchAgentService(env).stop()).rejects.toThrow('still loaded after bootout (exit 1)')
})

test('configuredDataDir and configuredPort read the plist', () => {
  world = createWorld({ withLibrary: false })
  const w = world
  const folder = '/a & <b>'
  const env = { ...w.env, dataDir: folder }
  const service = new LaunchAgentService(env)
  expect(service.isConfigured()).toBe(false)
  expect(service.configuredDataDir()).toBeNull()
  expect(service.configuredPort()).toBeNull()

  const plain = plistContent(env)
  writePlist(w, plain)
  expect(service.isConfigured()).toBe(true)
  expect(service.configuredDataDir()).toBe(folder)
  expect(service.configuredPort()).toBeNull()

  const port = `    <key>${envName('PORT')}</key><string>40000</string>\n`
  writePlist(w, plain.replace('  </dict>\n</dict>', `${port}  </dict>\n</dict>`))
  expect(service.configuredPort()).toBe(40000)
  writePlist(w, plain.replace('  </dict>\n</dict>', `    <key>${envName('PORT')}</key><integer>40001</integer>\n  </dict>\n</dict>`))
  expect(service.configuredPort()).toBe(40001)
  writePlist(w, plain.replace('  </dict>\n</dict>', `    <key>${envName('PORT')}</key><string>99999</string>\n  </dict>\n</dict>`))
  expect(service.configuredPort()).toBeNull()
})

test('fileHolders lists pids and command names, leaving this process out', async () => {
  world = createWorld()
  const w = world
  const env = {
    ...w.env,
    run: async (request: { argv: readonly string[] }) => {
      w.commands.push(request)
      if (request.argv[0] === LSOF) return { exitCode: 0, stdout: `${process.pid}\n4242\nnot-a-pid\n` }
      if (request.argv[0] === PS) return { exitCode: 0, stdout: '4242 bun\n' }
      return { exitCode: 1, stdout: '' }
    },
  }
  expect(await new LaunchAgentService(env).fileHolders('/x/memory.db')).toBe('4242 bun')
  expect(w.commands.map((c) => [...c.argv])).toEqual([[LSOF, '-t', '/x/memory.db'], [PS, '-o', 'pid=,comm=', '-p', '4242']])
  const none = { ...env, run: async () => ({ exitCode: 1, stdout: '' }) }
  expect(await new LaunchAgentService(none).fileHolders('/x/memory.db')).toBe('')
})

test('serviceFor gives the LaunchAgent on darwin and nothing elsewhere', () => {
  world = createWorld()
  expect(serviceFor(world.env)?.label).toBe('LaunchAgent')
  expect(serviceFor({ ...world.env, platform: 'linux' })).toBeNull()
})
