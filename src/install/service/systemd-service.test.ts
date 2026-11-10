import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { posixOnly } from '../../../test/platform-guards'
import { DEFAULT_PORT } from '../../daemon/daemon'
import { envName } from '../../env-names'
import type { InstallEnv } from '../env'
import { type FakeWorld, createWorld } from '../test-support'
import { SYSTEMD_UNIT, SystemdUserService, systemdQuote, systemdUserDir, unitContent, unitEnvironment } from './systemd-service'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

function linuxEnv(overrides: Partial<InstallEnv> = {}): InstallEnv {
  world = createWorld({ platform: 'linux', withLibrary: false })
  return { ...world.env, ...overrides }
}

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

  const service = new SystemdUserService(env)
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
  expect(() => new SystemdUserService(env).configContent(DEFAULT_PORT)).toThrow(refusal)
  expect(() => systemdQuote('x\x7fy')).toThrow('holds a control character and cannot go in a unit file')
  expect(() => systemdQuote('x\ty', { field: 'the home folder' })).toThrow('systemd user service: the home folder holds a control character')
  expect(world?.commands).toEqual([])
})

test('a data folder ending in a backslash or whitespace is refused without echoing it', () => {
  const refusal = 'systemd user service: the data folder ends in a backslash or a space and cannot go in a unit file'
  for (const dataDir of ['/tmp/kf\\', '/tmp/kf ', '/tmp/kf\t']) {
    const env = programEnv(dataDir)
    expect(() => unitContent(env, DEFAULT_PORT)).toThrow(refusal)
    expect(() => new SystemdUserService(env).configContent(DEFAULT_PORT)).toThrow(refusal)
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
  const service = new SystemdUserService(env)
  expect(service.configPath()).toBe(`/c/systemd/user/${SYSTEMD_UNIT}`)
  expect(service.configContent(DEFAULT_PORT)).toBe(unitContent(env, DEFAULT_PORT))
  expect(unitContent(env, DEFAULT_PORT)).not.toContain('XDG_CONFIG_HOME')

  expect(systemdUserDir({ homeDir: env.homeDir, envVars: { XDG_CONFIG_HOME: 'relative/config' } })).toBe(join(env.homeDir, '.config', 'systemd', 'user'))
  expect(systemdUserDir({ homeDir: env.homeDir, envVars: { XDG_CONFIG_HOME: '' } })).toBe(join(env.homeDir, '.config', 'systemd', 'user'))
  expect(systemdUserDir({ homeDir: env.homeDir })).toBe(join(env.homeDir, '.config', 'systemd', 'user'))
})

test('a port that is not a port reads as null', () => {
  const env = linuxEnv()
  const service = new SystemdUserService(env)
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
  const service = new SystemdUserService(env)
  writeUnit(service, '[Service]\nEnvironment="HOME=/h"\n')
  expect(service.configuredDataDir()).toBeNull()
  writeUnit(service, `[Service]\nEnvironment="${envName('DATA_DIR')}="\n`)
  expect(service.configuredDataDir()).toBeNull()
})

test('the service still refuses to start, stop or describe a step', async () => {
  const env = linuxEnv()
  const service = new SystemdUserService(env)
  const refusal = 'systemd user service: not supported on this platform yet'
  expect(service.label).toBe('systemd user service')
  await expect(service.start()).rejects.toThrow(refusal)
  await expect(service.stop()).rejects.toThrow(refusal)
  expect(service.describe('start')).toBe(refusal)
  expect(await service.isRunning()).toBe(false)
  expect(await service.fileHolders('/x/memory.db')).toBe('')
  expect(service.unavailableReason()).toBe('not set up on this platform yet')
  expect(world?.commands).toEqual([])
})
