import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { entryCommand } from '../../install/entry'
import { createWorld } from '../../install/test-support'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import { assertWriterContract, fileWriter } from '../families/writer-contract.test-support'
import { hookSpecFor } from '../hook-specs'
import { capabilityLine } from '../profile'
import { type HookBench, apply, hookBench, profile, writesOf } from './custom-hooks.test-support'
import { gooseFileActions, gooseFileUninstallActions, gooseHooksPath, goosePluginDir, goosePluginManifestPath } from './goose'

let bench: HookBench
beforeEach(() => {
  bench = hookBench()
})
afterEach(async () => {
  await bench.cleanup()
})

const moved = (raw: Record<string, unknown>, root: string): Record<string, unknown> => ({ ...raw, working_dir: root })

test('goose: the hook prints nothing on session start and prompt, nor on any other event', async () => {
  for (const file of ['docs-constructed-session-start.json', 'docs-constructed-user-prompt-submit.json', 'docs-constructed-post-tool-use.json', 'docs-constructed-stop.json', 'docs-constructed-session-end.json']) {
    expect(await bench.hook('goose', file, moved)).toBeNull()
  }
  expect(bench.asked).toEqual([])
  expect(hookSpecFor('goose')).toMatchObject({ sessionContextIgnored: true })
  expect(hookSpecFor('goose')?.promptContext).toBeUndefined()
})

test('goose: a minimal payload is not captured and the hook stays silent', async () => {
  expect(await bench.hook('goose', 'docs-constructed-post-tool-use.json', (raw) => ({ event: raw.event }))).toBeNull()
  expect(bench.asked).toEqual([])
})

test('goose: the plugin\'s hooks.json and plugin.json meet the writer contract and run kinfold hook --host goose', () => {
  const w = bench.world()
  expect(goosePluginDir(w.env)).toBe(join(w.env.homeDir, '.agents', 'plugins', 'kinfold'))
  expect(writesOf(gooseFileActions(w.env))).toEqual([goosePluginManifestPath(w.env), gooseHooksPath(w.env)])
  for (const path of [gooseHooksPath(w.env), goosePluginManifestPath(w.env)]) {
    const { write, remove } = fileWriter(path, () => gooseFileActions(w.env), () => gooseFileUninstallActions(w.env))
    assertWriterContract(write, remove, [null])
  }
  apply(gooseFileActions(w.env))
  const hooks = JSON.parse(readFileSync(gooseHooksPath(w.env), 'utf8')).hooks
  expect(Object.keys(hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'])
  expect(hooks.PostToolUse[0].matcher).toBeUndefined()
  expect(hooks.PostToolUse[0].hooks[0]).toMatchObject({ type: 'command', timeout: 10 })
  expect(hooks.PostToolUse[0].hooks[0].command).toEndWith(' --host goose')
  expect(JSON.parse(readFileSync(goosePluginManifestPath(w.env), 'utf8')).name).toBe('kinfold')
  expect(gooseFileActions(w.env)).toEqual([])
})

test('goose: a hooks.json by our name that is not ours is left alone', () => {
  const w = bench.world()
  const path = gooseHooksPath(w.env)
  const mine = '{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "say done" } ] } ] } }\n'
  mkdirSync(join(goosePluginDir(w.env), 'hooks'), { recursive: true })
  writeFileSync(path, mine)
  expect(writesOf(gooseFileActions(w.env))).not.toContain(path)
  expect(w.out.some((line) => line.includes(`${path} is not a Kinfold hook file; left alone`))).toBe(true)
  expect(gooseFileUninstallActions(w.env).flatMap((action) => (action.kind === 'remove' ? [action.path] : []))).not.toContain(path)
  expect(readFileSync(path, 'utf8')).toBe(mine)
})

test('goose: on Windows nothing is written, and the capability line says why', async () => {
  const goose = profile('goose')
  expect(goose.capabilities('windows')).toEqual({ capture: 'none', context: { sessionStart: false, prompt: false }, search: false, observer: false })
  expect(goose.limit('windows')).toContain('sh -c')
  const w = bench.world('win32')
  expect(await goose.wiring.install(w.env)).toEqual([])
})

test('goose: built from the docs, tool results only, MCP left to the user as YAML, and a full install is idempotent', async () => {
  const goose = profile('goose')
  expect(goose).toMatchObject({ id: 'goose', verification: 'docs' })
  expect(goose.capabilities('macos')).toEqual({ capture: 'partial', context: { sessionStart: false, prompt: false }, search: false, observer: false })
  expect(capabilityLine(goose, 'macos')).toStartWith('captures tool results only (')
  const steps = goose.manualSteps('macos', bench.world().env).join(' ')
  expect(steps).toContain('~/.config/goose/config.yaml')
  expect(steps).toContain('extensions:')
  const w = bench.world()
  apply(await goose.wiring.install(w.env))
  expect(goose.wiring.state(w.env)).toBe('yes')
  expect(await goose.wiring.install(w.env)).toEqual([])
  expect(goose.wiring.line(w.env)).toStartWith(`plugin yes in ${goosePluginDir(w.env)}; MCP`)
  apply(goose.wiring.uninstall(w.env))
  expect(goose.wiring.state(w.env)).toBe('no')
})

const PROGRAM = { kind: 'program', binPath: '/home/u/.kinfold/bin/kinfold' } as const

test('goose: the MCP step prints the command and args install would write, in checkout and program mode', () => {
  const w = bench.world()
  for (const env of [w.env, { ...w.env, mode: PROGRAM }]) {
    const entry = entryCommand(env.mode, 'mcp', env.dataDir)
    const step = profile('goose').manualSteps('macos', env).join('\n')
    expect(step).toContain(`cmd: ${JSON.stringify(entry.command)}`)
    expect(step).toContain(`args: ${JSON.stringify(entry.args)}`)
    expect(step).toContain(`envs: { ${MCP_HOST_ENV}: goose }`)
    expect(step).not.toContain('<kinfold')
  }
})

test('goose: a goose on PATH that is the pressly/goose migration tool is not detected as Goose', async () => {
  const detect = profile('goose').detection
  if (typeof detect !== 'function') throw new Error('goose detection must run goose --version and read its answer')
  const pressly = createWorld({ versionResults: { goose: { exitCode: 0, stdout: 'goose version: v3.24.1\n' } } })
  const block = createWorld({ versionResults: { goose: { exitCode: 0, stdout: '1.13.2\n' } } })
  try {
    expect(await detect(pressly.env, false)).toMatchObject({ host: 'goose', selected: false, note: 'goose on PATH is pressly/goose (database migrations), not Block\'s Goose' })
    expect(await detect(block.env, false)).toMatchObject({ host: 'goose', selected: true, version: '1.13.2' })
  } finally {
    await pressly.cleanup()
    await block.cleanup()
  }
})
