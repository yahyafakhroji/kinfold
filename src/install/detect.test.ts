import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { detectHosts, parseOpenCodeVersion, selectedHosts } from './detect'
import { type FakeWorld, createWorld } from './test-support'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

test('parses every opencode --version shape seen so far', () => {
  expect(parseOpenCodeVersion('opencode v2.1.4')).toEqual([2, 1, 4])
  expect(parseOpenCodeVersion('2.0.22\n')).toEqual([2, 0, 22])
  expect(parseOpenCodeVersion('v1.18.35')).toEqual([1, 18, 35])
  expect(parseOpenCodeVersion('opencode dev build')).toBeNull()
})

test('OpenCode 2.x is accepted, and Claude Code counts by its CLI', async () => {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)', opencodeVersion: 'opencode v2.1.4' })
  const detections = await detectHosts(world.env, null)
  expect(selectedHosts(detections)).toEqual(['claude-code', 'opencode'])
  expect(detections[1]).toMatchObject({ host: 'opencode', version: '2.1.4', selected: true })
})

test('OpenCode 1.x is refused with a clear reason; Claude Code still installs', async () => {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)', opencodeVersion: '1.18.35' })
  const detections = await detectHosts(world.env, null)
  expect(selectedHosts(detections)).toEqual(['claude-code'])
  expect(detections[1]?.note).toBe('OpenCode 1.18.35 is not supported: the plugin needs OpenCode 2.0 or later')
  const forced = await detectHosts(world.env, ['claude-code', 'opencode'])
  expect(selectedHosts(forced)).toEqual(['claude-code'])
})

test('neither host found selects nothing; ~/.claude alone counts for Claude Code', async () => {
  world = createWorld()
  expect(selectedHosts(await detectHosts(world.env, null))).toEqual([])
  mkdirSync(join(world.home, '.claude'))
  expect(selectedHosts(await detectHosts(world.env, null))).toEqual(['claude-code'])
})

test('--hosts overrides detection: it can add an undetected host or leave one out', async () => {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)' })
  expect(selectedHosts(await detectHosts(world.env, ['opencode']))).toEqual(['opencode'])
  expect(selectedHosts(await detectHosts(world.env, ['claude-code']))).toEqual(['claude-code'])
})
