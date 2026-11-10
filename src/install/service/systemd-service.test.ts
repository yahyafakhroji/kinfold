import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { posixOnly } from '../../../test/platform-guards'
import { DEFAULT_PORT } from '../../daemon/daemon'
import { envName } from '../../env-names'
import type { CommandResult, InstallEnv } from '../env'
import { type FakeWorld, createWorld } from '../test-support'
import { SYSTEMCTL_CANDIDATES, SYSTEMD_UNIT, SystemdUserService, procFileHolders, systemctlArgv, systemdQuote, systemdUserDir, unitContent, unitEnvironment, userManagerOf } from './systemd-service'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const SYSTEMCTL = '/usr/bin/systemctl'

/** A Linux env whose user manager is reachable, so the service writes and reads its unit. */
function linuxEnv(overrides: Partial<InstallEnv> = {}): InstallEnv {
  world = createWorld({ platform: 'linux', withLibrary: false })
  const runtimeDir = join(world.root, 'run')
  mkdirSync(join(runtimeDir, 'systemd'), { recursive: true })
  writeFileSync(join(runtimeDir, 'systemd', 'private'), '')
  return { ...world.env, ...overrides, envVars: { XDG_RUNTIME_DIR: runtimeDir, ...overrides.envVars } }
}

const serviceFor = (env: InstallEnv): SystemdUserService => new SystemdUserService(env, { systemctl: SYSTEMCTL })

function programEnv(dataDir: string, overrides: Partial<InstallEnv> = {}): InstallEnv {
  // A literal POSIX path, so the expected ExecStart holds no Windows separator to escape.
  return linuxEnv({ dataDir, mode: { kind: 'program', binPath: `${dataDir}/bin/kinfold` }, ...overrides })
}

function writeUnit(service: SystemdUserService, content: string): void {
  const path = service.configPath()
  if (path === null) throw new Error('no unit path')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

const lineStarting = (text: string, prefix: string): string | undefined => text.split('\n').find((line) => line.startsWith(prefix))

test('the unit runs the installed program with the data folder', () => {
  const dataDir = '/srv/kinfold data'
  const env = programEnv(dataDir)
  const unit = unitContent(env, DEFAULT_PORT)
  expect(lineStarting(unit, 'ExecStart=')).toBe(`ExecStart="${dataDir}/bin/kinfold" "--data-dir" "${dataDir}" "daemon"`)
  expect(unit).not.toContain(envName('PORT'))
  expect(unit.split('\n')).toContain('UMask=0077')
  expect(unit.split('\n')).toContain('WantedBy=default.target')
  expect(unit.split('\n')).toContain(`WorkingDirectory=${dataDir}`)
  expect(unitEnvironment(unit).get(envName('DATA_DIR'))).toBe(dataDir)
  expect(unitEnvironment(unit).get('HOME')).toBe(env.homeDir)
})

test('a daemon that fails at start keeps being retried rather than left failed', () => {
  const lines = unitContent(programEnv('/srv/kinfold'), DEFAULT_PORT).split('\n')
  // systemd's default start limit would leave the unit failed for the session after five quick exits.
  expect(lines.indexOf('StartLimitIntervalSec=0')).toBeGreaterThan(lines.indexOf('[Unit]'))
  expect(lines.indexOf('StartLimitIntervalSec=0')).toBeLessThan(lines.indexOf('[Service]'))
  expect(lines).toContain('Restart=always')
  expect(lines).toContain('RestartSec=10')
})

posixOnly('POSIX paths')('awkward paths survive the unit file', () => {
  const dataDir = '/tmp/a b/"q"/50%/$x\\y'
  const env = programEnv(dataDir)
  const unit = unitContent(env, 40000)
  const assignments = unitEnvironment(unit)
  expect(assignments.get(envName('DATA_DIR'))).toBe(dataDir)
  expect(assignments.get(envName('PORT'))).toBe('40000')
  const exec = lineStarting(unit, 'ExecStart=') ?? ''
  expect(exec).toContain('$$x')
  expect(exec).toContain('50%%')
  expect(exec).toContain('\\"q\\"')
  expect(exec).toContain('$$x\\\\y')
  expect(lineStarting(unit, 'WorkingDirectory=')).toBe('WorkingDirectory=/tmp/a b/"q"/50%%/$x\\y')
  expect(lineStarting(unit, 'StandardOutput=')).toBe('StandardOutput=append:/tmp/a b/"q"/50%%/$x\\y/logs/daemon.log')

  const service = serviceFor(env)
  expect(service.isConfigured()).toBe(false)
  expect(service.configuredDataDir()).toBeNull()
  writeUnit(service, unit)
  expect(service.isConfigured()).toBe(true)
  expect(service.configuredDataDir()).toBe(dataDir)
  expect(service.configuredPort()).toBe(40000)
})

test('systemdQuote escapes backslash, quote and percent, and dollar only for exec', () => {
  expect(systemdQuote('a\\b"c%d$e')).toBe('"a\\\\b\\"c%%d$e"')
  expect(systemdQuote('a\\b"c%d$e', { exec: true })).toBe('"a\\\\b\\"c%%d$$e"')
})

test('a control character is refused before anything is written', () => {
  const env = programEnv('/tmp/a\nb')
  const refusal = 'systemd user service: the data folder holds a control character and cannot go in a unit file'
  expect(() => unitContent(env, DEFAULT_PORT)).toThrow(refusal)
  expect(() => serviceFor(env).configContent(DEFAULT_PORT)).toThrow(refusal)
  expect(() => systemdQuote('x\x7fy')).toThrow('holds a control character and cannot go in a unit file')
  expect(() => systemdQuote('x\ty', { field: 'the home folder' })).toThrow('systemd user service: the home folder holds a control character')
  expect(world?.commands).toEqual([])
})

test('a data folder ending in a backslash or whitespace is refused without echoing it', () => {
  const refusal = 'systemd user service: the data folder ends in a backslash or a space and cannot go in a unit file'
  for (const dataDir of ['/tmp/kf\\', '/tmp/kf ', '/tmp/kf\t']) {
    const env = programEnv(dataDir)
    expect(() => unitContent(env, DEFAULT_PORT)).toThrow(refusal)
    expect(() => serviceFor(env).configContent(DEFAULT_PORT)).toThrow(refusal)
  }
  expect(world?.commands).toEqual([])
})

test('a port the installer would refuse never goes in the unit', () => {
  const env = linuxEnv()
  for (const port of [0, 1023, 65_536, 40000.5, Number.NaN]) {
    expect(() => unitContent(env, port)).toThrow('systemd user service: the port must be a whole number from 1024 to 65535')
  }
  expect(unitEnvironment(unitContent(env, 1024)).get(envName('PORT'))).toBe('1024')
  expect(unitEnvironment(unitContent(env, 65_535)).get(envName('PORT'))).toBe('65535')
})

posixOnly('POSIX paths')('the unit folder follows an absolute XDG_CONFIG_HOME', () => {
  const env = linuxEnv({ envVars: { XDG_CONFIG_HOME: '/c' } })
  const service = serviceFor(env)
  expect(service.configPath()).toBe(`/c/systemd/user/${SYSTEMD_UNIT}`)
  expect(service.configContent(DEFAULT_PORT)).toBe(unitContent(env, DEFAULT_PORT))
  expect(unitContent(env, DEFAULT_PORT)).not.toContain('XDG_CONFIG_HOME')

  expect(systemdUserDir({ homeDir: env.homeDir, envVars: { XDG_CONFIG_HOME: 'relative/config' } })).toBe(join(env.homeDir, '.config', 'systemd', 'user'))
  expect(systemdUserDir({ homeDir: env.homeDir, envVars: { XDG_CONFIG_HOME: '' } })).toBe(join(env.homeDir, '.config', 'systemd', 'user'))
  expect(systemdUserDir({ homeDir: env.homeDir })).toBe(join(env.homeDir, '.config', 'systemd', 'user'))
})

test('a port that is not a port reads as null', () => {
  const env = linuxEnv()
  const service = serviceFor(env)
  const unit = unitContent(env, 40000)
  const portLine = `Environment="${envName('PORT')}=40000"`
  expect(unit.split('\n')).toContain(portLine)
  for (const bad of ['0', '70000', 'x', '']) {
    writeUnit(service, unit.replace(portLine, `Environment="${envName('PORT')}=${bad}"`))
    expect(service.configuredPort()).toBeNull()
  }
  writeUnit(service, unitContent(env, DEFAULT_PORT))
  expect(service.configuredPort()).toBeNull()
  expect(service.configuredDataDir()).toBe(env.dataDir)
})

test('a unit with no data folder line reads as null', () => {
  const env = linuxEnv()
  const service = serviceFor(env)
  writeUnit(service, '[Service]\nEnvironment="HOME=/h"\n')
  expect(service.configuredDataDir()).toBeNull()
  writeUnit(service, `[Service]\nEnvironment="${envName('DATA_DIR')}="\n`)
  expect(service.configuredDataDir()).toBeNull()
})

/** env, XDG_RUNTIME_DIR=, systemctl, --user: what comes before the systemctl arguments. */
const ARGV_PREFIX = 4

type Answer = (args: readonly string[]) => CommandResult | undefined

/** A Linux world whose user manager is reachable; `answer` gets the systemctl arguments only. */
function managerWorld(answer: Answer = () => ({ exitCode: 0, stdout: '' })): { service: SystemdUserService; runtimeDir: string; calls: () => string[][] } {
  let runtimeDir = ''
  world = createWorld({
    platform: 'linux',
    withLibrary: false,
    commandOverride: (argv) => (argv[2] === SYSTEMCTL ? answer(argv.slice(ARGV_PREFIX)) : undefined),
  })
  runtimeDir = join(world.root, 'run')
  mkdirSync(join(runtimeDir, 'systemd'), { recursive: true })
  writeFileSync(join(runtimeDir, 'systemd', 'private'), '')
  const env = { ...world.env, envVars: { XDG_RUNTIME_DIR: runtimeDir } }
  const recorded = world
  return {
    service: new SystemdUserService(env, { systemctl: SYSTEMCTL }),
    runtimeDir,
    calls: () => recorded.commands.map((c) => [...c.argv]),
  }
}

const loaded: Answer = (args) => ({ exitCode: 0, stdout: args[0] === 'show' ? 'loaded\n' : '' })

test('systemctl runs through env with the runtime dir, and the candidates are the usual two', () => {
  expect(SYSTEMCTL_CANDIDATES).toEqual(['/usr/bin/systemctl', '/bin/systemctl'])
  expect(systemctlArgv({ runtimeDir: '/run/user/1000', systemctl: SYSTEMCTL }, ['is-active', '--quiet', SYSTEMD_UNIT]))
    .toEqual(['/usr/bin/env', 'XDG_RUNTIME_DIR=/run/user/1000', SYSTEMCTL, '--user', 'is-active', '--quiet', SYSTEMD_UNIT])
})

test('start reloads, checks the unit loaded, then enables it', async () => {
  const { service, runtimeDir, calls } = managerWorld(loaded)
  await service.start()
  const manager = { runtimeDir, systemctl: SYSTEMCTL }
  expect(calls()).toEqual([
    systemctlArgv(manager, ['daemon-reload']),
    systemctlArgv(manager, ['show', '--property=LoadState', '--value', SYSTEMD_UNIT]),
    systemctlArgv(manager, ['enable', '--now', SYSTEMD_UNIT]),
  ])
  expect(world?.commands.every((c) => c.timeoutMs === 15_000)).toBe(true)
})

test('a unit the manager did not load is refused', async () => {
  const { service, calls } = managerWorld((args) => ({ exitCode: 0, stdout: args[0] === 'show' ? 'not-found\n' : '' }))
  const path = service.configPath()
  await expect(service.start()).rejects.toThrow(`systemd user service: the user manager did not load ${path}; it reads units from another config folder (check XDG_CONFIG_HOME). Nothing was started`)
  expect(calls().some((argv) => argv.includes('enable'))).toBe(false)
})

/** Answers is-active from a script of states (the last one repeats); everything else exits 0 unless `others` says otherwise. */
function scripted(states: readonly (string | 'timeout')[], others: Answer = () => ({ exitCode: 0, stdout: '' })): Answer {
  const queue = [...states]
  return (args) => {
    if (args[0] !== 'is-active') return others(args)
    const state = queue.length > 1 ? queue.shift() : queue[0]
    if (state === 'timeout') return { exitCode: 143, stdout: '', timedOut: true }
    return { exitCode: state === 'active' ? 0 : 3, stdout: `${state}\n` }
  }
}

const verbs = (calls: string[][]): string[] => calls.map((argv) => argv.slice(ARGV_PREFIX).join(' '))

test('stop disables and waits until the unit is inactive', async () => {
  const { service, runtimeDir, calls } = managerWorld(scripted(['deactivating', 'deactivating', 'inactive']))
  await service.stop()
  const manager = { runtimeDir, systemctl: SYSTEMCTL }
  const isActive = systemctlArgv(manager, ['is-active', SYSTEMD_UNIT])
  expect(calls()).toEqual([systemctlArgv(manager, ['disable', '--now', SYSTEMD_UNIT]), isActive, isActive, isActive])
})

test('a unit that keeps running after disable --now is refused', async () => {
  const { service } = managerWorld(scripted(['active']))
  await expect(service.stop()).rejects.toThrow('the systemd user service is still active after disable --now; it may still be running')
})

test('a disable cut off by its timeout while systemd is still stopping is refused, never reported as stopped', async () => {
  const { service, calls } = managerWorld(scripted(['deactivating'], (args) => (args[0] === 'disable' ? { exitCode: 143, stdout: '', timedOut: true } : { exitCode: 0, stdout: '' })))
  const failure = await service.stop().then(() => null, (error: unknown) => error as Error)
  expect(failure?.message).toBe('the systemd user service is still deactivating after disable --now; it may still be running')
  expect(failure?.message).not.toContain('exit')
  expect(verbs(calls()).filter((verb) => verb.startsWith('is-active')).length).toBeGreaterThan(1)
})

test('after a cut-off disable the unit is disabled again once it has stopped', async () => {
  const { service, calls } = managerWorld(scripted(['deactivating', 'inactive'], (args) => (args[0] === 'disable' && args[1] === '--now' ? { exitCode: 143, stdout: '', timedOut: true } : { exitCode: 0, stdout: '' })))
  await service.stop()
  expect(verbs(calls())).toEqual([`disable --now ${SYSTEMD_UNIT}`, `is-active ${SYSTEMD_UNIT}`, `is-active ${SYSTEMD_UNIT}`, `disable ${SYSTEMD_UNIT}`])
})

test('a failing disable is reported, not swallowed', async () => {
  const { service, calls } = managerWorld(scripted(['inactive'], (args) => (args[0] === 'disable' ? { exitCode: 1, stdout: 'token=abc' } : { exitCode: 0, stdout: '' })))
  await expect(service.stop()).rejects.toThrow(`systemd user service: systemctl --user disable --now ${SYSTEMD_UNIT} failed (exit 1)`)
  expect(verbs(calls())).toEqual([`disable --now ${SYSTEMD_UNIT}`])
})

test('a unit that ends failed is reset so it is not left listed as failed', async () => {
  const { service, calls } = managerWorld(scripted(['deactivating', 'failed']))
  await service.stop()
  expect(verbs(calls()).at(-1)).toBe(`reset-failed ${SYSTEMD_UNIT}`)
})

test('a state systemctl never reports during stop is refused', async () => {
  const { service } = managerWorld(scripted(['timeout']))
  await expect(service.stop()).rejects.toThrow('the systemd user service is in a state systemctl did not report after disable --now; it may still be running')
})

test('a failing systemctl reports its exit code only', async () => {
  const { service } = managerWorld((args) => (args[0] === 'enable' ? { exitCode: 1, stdout: 'token=abc' } : loaded(args)))
  const failure = await service.start().then(() => null, (error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  const message = (failure as Error).message
  expect(message).toBe('systemd user service: systemctl --user enable --now kinfold.service failed (exit 1)')
  expect(message).not.toContain('abc')
})

test('start and stop describe their systemctl steps', () => {
  const { service } = managerWorld()
  expect(service.describe('start')).toBe('systemd user service: systemctl --user daemon-reload, then systemctl --user enable --now kinfold.service')
  expect(service.describe('stop')).toBe('systemd user service: systemctl --user disable --now kinfold.service')
})

test('isRunning reads the printed state, and an enabled unit counts as loaded', async () => {
  for (const state of ['active', 'activating', 'deactivating', 'reloading', 'refreshing']) {
    const { service, calls } = managerWorld(scripted([state]))
    expect(await service.isRunning()).toBe(true)
    expect(verbs(calls())).toEqual([`is-active ${SYSTEMD_UNIT}`])
    await world?.cleanup()
  }
  for (const [state, enabled, expected] of [['inactive', 'enabled', true], ['failed', 'enabled', true], ['inactive', 'disabled', false], ['failed', 'disabled', false], ['inactive', 'not-found', false]] as const) {
    const { service } = managerWorld(scripted([state], (args) => ({ exitCode: enabled === 'enabled' ? 0 : 1, stdout: args[0] === 'is-enabled' ? `${enabled}\n` : '' })))
    expect(await service.isRunning()).toBe(expected)
    await world?.cleanup()
  }
})

test('isRunning refuses to guess when systemctl gives no state', async () => {
  const unknown = 'systemd user service: systemctl --user is-active kinfold.service gave no known state; the service state is unknown'
  for (const state of ['timeout', '', 'something-new']) {
    const { service } = managerWorld(scripted([state]))
    await expect(service.isRunning()).rejects.toThrow(unknown)
    await world?.cleanup()
  }
  const { service } = managerWorld(scripted(['inactive'], () => ({ exitCode: 143, stdout: '', timedOut: true })))
  await expect(service.isRunning()).rejects.toThrow('systemd user service: systemctl --user is-enabled kinfold.service did not answer; the service state is unknown')
})

test('a timed-out systemctl step names no exit code', async () => {
  const { service } = managerWorld((args) => (args[0] === 'daemon-reload' ? { exitCode: 143, stdout: '', timedOut: true } : loaded(args)))
  await expect(service.start()).rejects.toThrow('systemd user service: systemctl --user daemon-reload did not finish within 15 s')
})

test('no reachable user manager means no unit and no systemctl', async () => {
  const reachable = managerWorld(loaded)
  expect(reachable.service.unavailableReason()).toBeNull()
  expect(reachable.service.configPath()).toBe(join(systemdUserDir(world!.env), SYSTEMD_UNIT))
  const runtimeDir = reachable.runtimeDir
  const recorded = world!
  const base = world!.env
  const missing = `${join(recorded.root, 'nowhere')}/systemd/private`
  const cases: { envVars: Record<string, string>; systemctl: string | null; reason: string }[] = [
    { envVars: {}, systemctl: SYSTEMCTL, reason: 'XDG_RUNTIME_DIR is not set' },
    { envVars: { XDG_RUNTIME_DIR: '' }, systemctl: SYSTEMCTL, reason: 'XDG_RUNTIME_DIR is not set' },
    { envVars: { XDG_RUNTIME_DIR: runtimeDir }, systemctl: null, reason: 'systemctl is not installed' },
    { envVars: { XDG_RUNTIME_DIR: join(recorded.root, 'nowhere') }, systemctl: SYSTEMCTL, reason: `${missing} does not exist` },
  ]
  for (const { envVars, systemctl, reason } of cases) {
    expect(userManagerOf({ envVars }, systemctl)).toEqual({ reachable: false, reason })
    const service = new SystemdUserService({ ...base, envVars }, { systemctl })
    const unreachable = `no user service manager is reachable (${reason})`
    expect(service.unavailableReason()).toBe(unreachable)
    expect(service.configPath()).toBeNull()
    expect(service.configContent(37_811)).toBeNull()
    expect(await service.isRunning()).toBe(false)
    await expect(service.start()).rejects.toThrow(`systemd user service: ${unreachable}`)
    await expect(service.stop()).rejects.toThrow(`systemd user service: ${unreachable}`)
  }
  expect(recorded.commands).toEqual([])
})

posixOnly('file modes')('fileHolders reads /proc', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sam-proc-'))
  const procRoot = join(root, 'proc')
  try {
    const store = join(root, 'memory.db')
    writeFileSync(store, '')
    const real = realpathSync(store)
    mkdirSync(join(procRoot, '123', 'fd'), { recursive: true })
    symlinkSync(real, join(procRoot, '123', 'fd', '4'))
    symlinkSync('/dev/null', join(procRoot, '123', 'fd', '0'))
    writeFileSync(join(procRoot, '123', 'comm'), 'kinfold\n')
    mkdirSync(join(procRoot, String(process.pid), 'fd'), { recursive: true })
    symlinkSync(real, join(procRoot, String(process.pid), 'fd', '3'))
    mkdirSync(join(procRoot, '456', 'fd'), { recursive: true })
    chmodSync(join(procRoot, '456', 'fd'), 0o000)
    mkdirSync(join(procRoot, 'self'))
    expect(procFileHolders(procRoot, store, process.pid)).toBe('123 kinfold')

    world = createWorld({ platform: 'linux', withLibrary: false })
    const service = new SystemdUserService(world.env, { systemctl: SYSTEMCTL, procRoot })
    expect(await service.fileHolders(store)).toBe('123 kinfold')
    expect(world.commands).toEqual([])
    expect(procFileHolders(join(root, 'no-proc'), store, process.pid)).toBe('')
    expect(procFileHolders(procRoot, join(root, 'gone.db'), process.pid)).toBe('')
  } finally {
    chmodSync(join(procRoot, '456', 'fd'), 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})
