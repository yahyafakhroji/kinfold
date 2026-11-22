import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MCP_SERVER_NAME } from '../../install/mcp-config'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import { jsonAgentFileInstallActions, jsonAgentFileUninstallActions } from '../families/json-agent'
import { entryCommand } from '../../install/entry'
import { hookTarget, shellCommand } from '../families/json-hooks'
import { assertWriterContract, fileWriter } from '../families/writer-contract.test-support'
import { hookSpecFor } from '../hook-specs'
import { capabilityLine } from '../profile'
import { CRUSH_MCP_FILE, crushConfigDir } from './crush'
import { type HookBench, apply, hookBench, profile, writesOf } from './custom-hooks.test-support'

let bench: HookBench
beforeEach(() => {
  bench = hookBench()
})
afterEach(async () => {
  await bench.cleanup()
})

const moved = (raw: Record<string, unknown>, root: string): Record<string, unknown> => ({ ...raw, cwd: root })

test('crush: the hook prints nothing on session start and prompt, nor on any other event', async () => {
  for (const file of ['docs-constructed-session-start.json', 'docs-constructed-turn-start.json', 'docs-constructed-post-tool-use.json', 'docs-constructed-turn-end.json', 'docs-constructed-session-end.json']) {
    expect(await bench.hook('crush', file, moved)).toBeNull()
  }
  expect(bench.asked).toEqual([])
  expect(hookSpecFor('crush')).toMatchObject({ sessionContextIgnored: true })
  expect(hookSpecFor('crush')?.promptContext).toBeUndefined()
})

test('crush: a minimal payload is not captured and the hook stays silent', async () => {
  expect(await bench.hook('crush', 'docs-constructed-session-start.json', (raw) => ({ hook_event_name: raw.hook_event_name }))).toBeNull()
  expect(bench.asked).toEqual([])
})

test('crush: the MCP server under "mcp" in crush.json meets the writer contract and honours XDG_CONFIG_HOME', () => {
  const w = bench.world()
  const path = CRUSH_MCP_FILE.path(w.env)
  expect(path).toBe(join(w.env.homeDir, '.config', 'crush', 'crush.json'))
  const { write, remove } = fileWriter(path, () => jsonAgentFileInstallActions(w.env, 'crush', CRUSH_MCP_FILE), () => jsonAgentFileUninstallActions(w.env, 'crush', CRUSH_MCP_FILE))
  assertWriterContract(write, remove, [null, `${JSON.stringify({ $schema: 'https://charm.land/crush.json', mcp: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } } }, null, 2)}\n`])
  const entry = JSON.parse(write(null) ?? '{}').mcp[MCP_SERVER_NAME]
  expect(entry).toMatchObject({ type: 'stdio', env: { [MCP_HOST_ENV]: 'crush' } })

  const xdg = join(w.root, 'xdg')
  expect(crushConfigDir({ ...w.env, xdgConfigHomeEnv: xdg })).toBe(join(xdg, 'crush'))
  expect(crushConfigDir({ ...w.env, xdgConfigHomeEnv: 'relative' })).toBe(join(w.env.homeDir, '.config', 'crush'))
})

test('crush: with a crushrc and no crush.json, no crush.json is created and the user is told to add the server by hand', async () => {
  const w = bench.world()
  mkdirSync(crushConfigDir(w.env), { recursive: true })
  writeFileSync(join(crushConfigDir(w.env), 'crushrc'), 'permissions allow view\n')
  expect(await profile('crush').wiring.install(w.env)).toEqual([])
  expect(w.out.at(-1)).toContain('crushrc')
  expect(profile('crush').wiring.line(w.env)).toContain('crushrc')
  expect(readFileSync(join(crushConfigDir(w.env), 'crushrc'), 'utf8')).toBe('permissions allow view\n')
})

test('crush: a crush.json that is not plain JSON is skipped with the reason and left untouched', async () => {
  const w = bench.world()
  const path = CRUSH_MCP_FILE.path(w.env)
  mkdirSync(crushConfigDir(w.env), { recursive: true })
  writeFileSync(path, '{ "mcp": {}, }\n')
  expect(await profile('crush').wiring.install(w.env)).toEqual([])
  expect(w.out.at(-1)).toContain('crush: skipped;')
  expect(readFileSync(path, 'utf8')).toBe('{ "mcp": {}, }\n')
})

test('crush: search only on every OS, crushrc hooks are a manual step, and a full install is idempotent', async () => {
  const crush = profile('crush')
  expect(crush).toMatchObject({ id: 'crush', verification: 'docs', detection: { binaries: ['crush'] } })
  for (const os of ['macos', 'linux', 'windows'] as const) {
    expect(crush.capabilities(os)).toEqual({ capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false })
    expect(capabilityLine(crush, os)).toStartWith('search only (')
    expect(crush.manualSteps(os, bench.world(os === 'windows' ? 'win32' : os === 'linux' ? 'linux' : 'darwin').env).join('\n')).toContain('hook add PostToolUse')
  }
  expect(crush.limit('macos')).toContain('crushrc')
  const w = bench.world()
  expect(writesOf(await crush.wiring.install(w.env))).toEqual([CRUSH_MCP_FILE.path(w.env)])
  apply(await crush.wiring.install(w.env))
  expect(crush.wiring.state(w.env)).toBe('yes')
  expect(await crush.wiring.install(w.env)).toEqual([])
  expect(crush.wiring.line(w.env)).toBe(`MCP yes in ${CRUSH_MCP_FILE.path(w.env)}`)
  apply(crush.wiring.uninstall(w.env))
  expect(crush.wiring.state(w.env)).toBe('no')
})

/** A word as Bash reads it back from double quotes, where \, ", $ and ` need a backslash. */
const inDoubleQuotes = (word: string): string => `"${word.replace(/[\\"$`]/g, '\\$&')}"`

const PROGRAM = { kind: 'program', binPath: '/home/u/.kinfold/bin/kinfold' } as const

test('crush: the hook and MCP lines print the commands install would write, in checkout and program mode', () => {
  const w = bench.world()
  for (const env of [w.env, { ...w.env, mode: PROGRAM }]) {
    const step = profile('crush').manualSteps('macos', env).join('\n')
    const hook = shellCommand(hookTarget(env, 'crush').entry)
    expect(step).toContain(`hook add PostToolUse --name kinfold --command ${inDoubleQuotes(hook)} --timeout 10`)
    const mcp = entryCommand(env.mode, 'mcp', env.dataDir)
    expect(step).toContain(`mcp add kinfold --command ${inDoubleQuotes(mcp.command)} ${mcp.args.map((arg) => `--args ${inDoubleQuotes(arg)}`).join(' ')} --env ${MCP_HOST_ENV} crush`)
    expect(step).toContain(join(crushConfigDir(env), 'crushrc'))
    // Crush's docs don't say how crushrc reads flags, so the step asks for a check.
    expect(step).toContain('check that Crush accepts this line')
    expect(step).not.toContain("'kinfold hook")
  }
})

test('crush: a Windows path in the crushrc lines keeps its backslashes once Bash reads the double quotes', () => {
  const w = bench.world('win32')
  const env = { ...w.env, dataDir: 'C:\\Users\\u\\.kinfold' }
  const step = profile('crush').manualSteps('windows', env).join('\n')
  expect(step).toContain(`--data-dir 'C:\\\\Users\\\\u\\\\.kinfold' --host crush" --timeout 10`)
  expect(step).toContain(`--args "C:\\\\Users\\\\u\\\\.kinfold" --env ${MCP_HOST_ENV} crush`)
})
