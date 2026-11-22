import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { installPaths } from './env'
import { EXIT_OK, install } from './install'
import { LAUNCHCTL } from './launch-agent'
import { type FakeWorld, YES, createWorld } from './test-support'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const bootstraps = (w: FakeWorld): number => w.commands.filter((request) => request.argv[0] === LAUNCHCTL && request.argv[1] === 'bootstrap').length

/** Installs once, then edits the plist so the next install must bootout and bootstrap again. */
async function installedWithStalePlist(): Promise<FakeWorld> {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)', opencodeVersion: '2.1.4', keychainRefs: ['openrouter'] })
  expect(await install(world.env, YES)).toBe(EXIT_OK)
  const plist = installPaths(world.env).launchAgentPlist
  writeFileSync(plist, readFileSync(plist, 'utf8').replace('<key>HOME</key>', '<key>OLD</key><string>x</string><key>HOME</key>'))
  world.commands.length = 0
  return world
}

test('a bootstrap that launchd answers with exit 5 while the old job tears down is retried', async () => {
  const w = await installedWithStalePlist()
  w.launchd.busyAfterBootout = 2
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(bootstraps(w)).toBe(3)
  expect(w.launchd.loaded).toBe(true)
})

test('a bootstrap still refused after every retry fails the install with the exit code', async () => {
  const w = await installedWithStalePlist()
  w.launchd.busyAfterBootout = 1_000
  expect(await install(w.env, YES)).not.toBe(EXIT_OK)
  expect(w.out.join('\n')).toContain('bootstrap failed (exit 5)')
})
