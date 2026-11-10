import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PORT } from '../../daemon/daemon'
import type { CommandResult, InstallEnv } from '../env'
import { install } from '../install'
import { type FakeWorld, YES, createWorld } from '../test-support'
import { uninstall } from '../uninstall'
import { SYSTEMD_UNIT, SystemdUserService, unitContent } from './systemd-service'

const SYSTEMCTL = '/usr/bin/systemctl'
/** env, XDG_RUNTIME_DIR=, systemctl, --user: what comes before the systemctl arguments. */
const ARGV_PREFIX = 4

type Answer = (args: readonly string[]) => CommandResult

const idle: Answer = (args) => {
  if (args[0] === 'is-active') return { exitCode: 3, stdout: 'inactive\n' }
  if (args[0] === 'is-enabled') return { exitCode: 1, stdout: 'disabled\n' }
  return { exitCode: 0, stdout: '' }
}

/** A unit systemd keeps restarting (or one only enabled) until disable --now stops it. */
function untilDisabled(running: 'activating' | 'inactive'): { answer: Answer; disabled: () => boolean } {
  let disabled = false
  const answer: Answer = (args) => {
    if (args[0] === 'disable') disabled = true
    if (args[0] === 'is-active') return disabled ? { exitCode: 3, stdout: 'inactive\n' } : { exitCode: 3, stdout: `${running}\n` }
    if (args[0] === 'is-enabled') return disabled ? { exitCode: 1, stdout: 'disabled\n' } : { exitCode: 0, stdout: 'enabled\n' }
    return { exitCode: 0, stdout: '' }
  }
  return { answer, disabled: () => disabled }
}

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

/** A Linux world; `reachable` gives it a runtime dir with the user manager's private socket. */
function linuxWorld(reachable: boolean, answer: Answer = idle): InstallEnv {
  const w = createWorld({
    platform: 'linux',
    // Nothing is active or enabled, so install plans a start.
    commandOverride: (argv) => (argv[2] === SYSTEMCTL ? answer(argv.slice(ARGV_PREFIX)) : undefined),
  })
  world = w
  const runtimeDir = join(w.root, 'run')
  if (reachable) {
    mkdirSync(join(runtimeDir, 'systemd'), { recursive: true })
    writeFileSync(join(runtimeDir, 'systemd', 'private'), '')
  }
  const env: InstallEnv = { ...w.env, envVars: reachable ? { XDG_RUNTIME_DIR: runtimeDir } : {} }
  return { ...env, service: new SystemdUserService(env, { systemctl: SYSTEMCTL }) }
}

const systemctlVerbs = (w: FakeWorld): string[] => w.commands.filter((c) => c.argv[2] === SYSTEMCTL).map((c) => c.argv[4] ?? '')

test('a Linux install writes the unit and starts it through systemctl', async () => {
  const env = linuxWorld(true)
  const w = world!
  await install(env, { ...YES, dryRun: true })
  const output = w.out.join('\n')
  expect(output).toContain(join(w.home, '.config', 'systemd', 'user', SYSTEMD_UNIT))
  expect(output).toContain('systemd user service: systemctl --user daemon-reload, then systemctl --user enable --now kinfold.service')
  expect(systemctlVerbs(w).filter((verb) => verb !== 'is-active' && verb !== 'is-enabled')).toEqual([])
})

test('a Linux install without a user manager prints the manual start line', async () => {
  const env = linuxWorld(false)
  const w = world!
  await install(env, { ...YES, dryRun: true })
  const output = w.out.join('\n')
  expect(output).toContain('systemd user service: no user service manager is reachable (XDG_RUNTIME_DIR is not set); start the daemon yourself with:')
  expect(output).not.toContain(SYSTEMD_UNIT)
  expect(systemctlVerbs(w)).toEqual([])
})

test('uninstall without a user manager leaves a unit written earlier in place', async () => {
  // A known limit: with no manager to disable it, the unit stays enabled until
  // the user runs systemctl --user disable --now kinfold.service.
  const env = linuxWorld(false)
  const w = world!
  const unitPath = join(w.home, '.config', 'systemd', 'user', SYSTEMD_UNIT)
  mkdirSync(join(w.home, '.config', 'systemd', 'user'), { recursive: true })
  writeFileSync(unitPath, unitContent(env, DEFAULT_PORT))
  await uninstall(env, { dryRun: false, removeCredentials: false })
  expect(existsSync(unitPath)).toBe(true)
  expect(systemctlVerbs(w)).toEqual([])
})

for (const running of ['activating', 'inactive'] as const) {
  test(`uninstall stops and disables an enabled unit that is ${running}, then removes it`, async () => {
    const unit = untilDisabled(running)
    const env = linuxWorld(true, unit.answer)
    const w = world!
    const unitPath = join(w.home, '.config', 'systemd', 'user', SYSTEMD_UNIT)
    mkdirSync(join(w.home, '.config', 'systemd', 'user'), { recursive: true })
    writeFileSync(unitPath, unitContent(env, DEFAULT_PORT))
    await uninstall(env, { dryRun: false, removeCredentials: false })
    expect(unit.disabled()).toBe(true)
    expect(systemctlVerbs(w)).toContain('disable')
    expect(existsSync(unitPath)).toBe(false)
  })
}
