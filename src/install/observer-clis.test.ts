import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { detectHosts } from './detect'
import { missingClis, notInstalled } from './observer-clis'
import { type FakeWorld, createWorld } from './test-support'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const versionProbes = (w: FakeWorld, binary: string): number => w.commands.filter((command) => command.argv[0] === binary && command.argv[1] === '--version').length

test('a CLI provider is missing when its CLI did not answer; openrouter never is', async () => {
  world = createWorld({ claudeVersion: '2.0.0' })
  const missing = await missingClis(world.env, await detectHosts(world.env, null))
  expect([...missing]).toEqual([['codex-cli', notInstalled('codex')], ['opencode-cli', notInstalled('opencode')]])
  expect(notInstalled('codex')).toBe('codex not installed')
})

test('the agent step\'s detections are reused: no CLI is asked for its version twice', async () => {
  world = createWorld({ claudeVersion: '2.0.0', codexVersion: '0.9.0', opencodeVersion: '2.1.0' })
  const detections = await detectHosts(world.env, null)
  expect((await missingClis(world.env, detections)).size).toBe(0)
  for (const binary of ['claude', 'codex', 'opencode']) expect(versionProbes(world, binary)).toBe(1)
})

test('an agent --hosts left out was never probed, so its CLI is looked for once', async () => {
  world = createWorld({ claudeVersion: '2.0.0', codexVersion: '0.9.0' })
  const detections = await detectHosts(world.env, ['claude-code'])
  expect(versionProbes(world, 'codex')).toBe(0)
  expect([...(await missingClis(world.env, detections)).keys()]).toEqual(['opencode-cli'])
  expect(versionProbes(world, 'codex')).toBe(1)
  expect(versionProbes(world, 'claude')).toBe(1)
})

test('a CLI that is there but did not answer says what happened, not that it is missing', async () => {
  world = createWorld({ claudeVersion: '2.0.0', versionResults: { codex: { exitCode: 3, stdout: '' } } })
  const missing = await missingClis(world.env, await detectHosts(world.env, null))
  expect(missing.get('codex-cli')).toBe('codex --version exited 3')
})

test('an agent found only by its app or its config folder has no CLI to observe with', async () => {
  world = createWorld()
  mkdirSync(join(world.home, '.claude'), { recursive: true })
  mkdirSync(join(world.root, 'Applications', 'Codex.app'), { recursive: true })
  const missing = await missingClis(world.env, await detectHosts(world.env, null))
  expect([...missing.keys()]).toEqual(['claude-cli', 'codex-cli', 'opencode-cli'])
})

test('claude failing --version beside ~/.claude keeps the agent and says why its CLI cannot observe', async () => {
  world = createWorld({ versionResults: { claude: { exitCode: 2, stdout: '' } } })
  mkdirSync(join(world.home, '.claude'), { recursive: true })
  const detections = await detectHosts(world.env, null)
  expect(detections.find((d) => d.host === 'claude-code')).toMatchObject({ selected: true, binaryProblem: 'claude --version exited 2' })
  expect((await missingClis(world.env, detections)).get('claude-cli')).toBe('claude --version exited 2')
})

test('a failing codex beside Codex.app, and one named by --hosts, both carry the reason', async () => {
  world = createWorld({ versionResults: { codex: { exitCode: 0, stdout: '', timedOut: true } } })
  const forced = (await detectHosts(world.env, ['codex'])).find((d) => d.host === 'codex')
  expect(forced).toMatchObject({ selected: true, binaryProblem: 'codex --version timed out after 5000 ms' })
  mkdirSync(join(world.root, 'Applications', 'Codex.app'), { recursive: true })
  const beside = (await detectHosts(world.env, null)).find((d) => d.host === 'codex')
  expect(beside).toMatchObject({ selected: true, binaryProblem: 'codex --version timed out after 5000 ms' })
  expect(beside?.binary).toBeUndefined()
})

test('an OpenCode whose version cannot be read is not wired, but its CLI is here to observe with', async () => {
  world = createWorld({ claudeVersion: '2.0.0', opencodeVersion: 'opencode dev build' })
  const detections = await detectHosts(world.env, null)
  expect(detections.find((d) => d.host === 'opencode')).toMatchObject({ selected: false, binary: 'opencode' })
  expect((await missingClis(world.env, detections)).has('opencode-cli')).toBe(false)
})

test('on Windows a CLI on PATH counts even when the version question could not start its .cmd shim', async () => {
  world = createWorld({ platform: 'win32' })
  const detections = await detectHosts(world.env, null)
  const which = (binary: string, path: string) => (binary === 'claude' && path === world?.env.pathEnv ? 'C:\\npm\\claude.cmd' : null)
  expect([...(await missingClis(world.env, detections, undefined, which)).keys()]).toEqual(['codex-cli', 'opencode-cli'])
  // Elsewhere the version question is the whole answer.
  world.env.platform = 'darwin'
  expect((await missingClis(world.env, detections, undefined, which)).has('claude-cli')).toBe(true)
})
