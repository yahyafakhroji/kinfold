import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DETECT_AT_ONCE, INSTALL_HOSTS, detectHosts, inOrder, parseOpenCodeVersion, selectedHosts } from '../../install/detect'
import { type FakeWorld, type WorldOptions, createWorld } from './test-support'

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

test('OpenCode detection names why it was skipped', async () => {
  const note = async (versionResults: NonNullable<WorldOptions['versionResults']>) => {
    world = createWorld({ versionResults })
    return (await detectHosts(world.env, null))[1]?.note
  }
  expect(await note({})).toBe('not found (no opencode on PATH)')
  expect(await note({ opencode: { exitCode: 2, stdout: '' } })).toBe('opencode --version exited 2')
  await world?.cleanup()
  expect(await note({ opencode: { exitCode: 143, stdout: '', timedOut: true } })).toBe('opencode --version timed out after 5000 ms')
  await world?.cleanup()
  expect(await note({ opencode: { exitCode: 0, stdout: 'opencode dev build\n' } })).toBe('opencode --version printed no version we could read')
  await world?.cleanup()
  expect(await note({ opencode: 'throw' })).toBe('opencode --version could not be run')
})

test('Claude Code, Codex and Cursor name the reason too, and an answer keeps its note', async () => {
  world = createWorld({
    versionResults: { claude: { exitCode: 3, stdout: '' }, codex: { exitCode: 143, stdout: '', timedOut: true }, cursor: { exitCode: 1, stdout: '' } },
  })
  const [claude, , codex, cursor] = await detectHosts(world.env, null)
  expect(claude?.note).toBe('claude --version exited 3')
  expect(codex?.note).toBe('codex --version timed out after 5000 ms')
  expect(cursor?.note).toBe('cursor --version exited 1')
  await world.cleanup()
  world = createWorld({ claudeVersion: '2.1.310', codexVersion: 'codex 1.0.0' })
  const answered = await detectHosts(world.env, null)
  expect(answered[0]?.note).toBe('claude --version answered')
  expect(answered[2]?.note).toBe('codex --version answered')
})

test('a forced OpenCode with no readable version says why, then that --hosts wired it', async () => {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)' })
  const missing = await detectHosts(world.env, ['opencode'])
  expect(missing.find((d) => d.host === 'opencode')).toMatchObject({ selected: true, version: null, note: 'not found (no opencode on PATH); wired because --hosts names it' })
  await world.cleanup()
  world = createWorld({ opencodeVersion: 'opencode dev build' })
  const unreadable = await detectHosts(world.env, ['opencode'])
  expect(unreadable.find((d) => d.host === 'opencode')?.note).toBe('opencode --version printed no version we could read; wired because --hosts names it')
  await world.cleanup()
  world = createWorld({ versionResults: { opencode: { exitCode: 3, stdout: 'SECRET-OUTPUT' } } })
  const exited = await detectHosts(world.env, ['opencode'])
  expect(exited.find((d) => d.host === 'opencode')?.note).toBe('opencode --version exited 3; wired because --hosts names it')
})

test('a detection names the binary that answered --version, and none for an app bundle or a config folder', async () => {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)', opencodeVersion: '1.18.35', codexVersion: '0.9.0' })
  const found = await detectHosts(world.env, null)
  expect(found.find((d) => d.host === 'claude-code')?.binary).toBe('claude')
  expect(found.find((d) => d.host === 'codex')?.binary).toBe('codex')
  // A 1.x OpenCode is not wired, but its CLI is on this machine.
  expect(found.find((d) => d.host === 'opencode')).toMatchObject({ selected: false, binary: 'opencode' })
  await world.cleanup()
  world = createWorld()
  mkdirSync(join(world.home, '.claude'), { recursive: true })
  mkdirSync(join(world.root, 'Applications', 'Codex.app'), { recursive: true })
  const other = await detectHosts(world.env, null)
  expect(other.find((d) => d.host === 'claude-code')).toMatchObject({ selected: true })
  expect(other.find((d) => d.host === 'claude-code')?.binary).toBeUndefined()
  expect(other.find((d) => d.host === 'codex')).toMatchObject({ selected: true })
  expect(other.find((d) => d.host === 'codex')?.binary).toBeUndefined()
})

test('probes run a few at a time, never more than the limit, and the answers keep the order asked', async () => {
  let running = 0
  let most = 0
  const work = async (item: number): Promise<string> => {
    running += 1
    most = Math.max(most, running)
    // Later items finish first, so order by finish would be reversed.
    await new Promise((resolve) => setTimeout(resolve, 20 - item))
    running -= 1
    return `r${item}`
  }
  expect(await inOrder([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3, work)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'])
  expect(most).toBe(3)
  expect(await inOrder([], 3, work)).toEqual([])
  expect(await inOrder([1], 0, (item) => item * 2)).toEqual([2])
  await expect(inOrder([1, 2], 2, async (item) => {
    if (item === 2) throw new Error('probe failed')
    return item
  })).rejects.toThrow('probe failed')
})

test('every agent is probed once, in the order of the agent list, whether or not it is installed', async () => {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)', opencodeVersion: 'opencode v2.1.4' })
  const detections = await detectHosts(world.env, null)
  expect(detections.map((detection) => detection.host)).toEqual([...INSTALL_HOSTS])
  const versionAsks = world.commands.filter((command) => command.argv.includes('--version')).map((command) => command.argv[0])
  expect(new Set(versionAsks).size).toBe(versionAsks.length)
  expect(DETECT_AT_ONCE).toBeGreaterThan(1)
})
