import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MCP_SERVER_NAME } from '../../install/mcp-config'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import { jsonAgentFileInstallActions, jsonAgentFileUninstallActions } from '../families/json-agent'
import { assertWriterContract, fileWriter } from '../families/writer-contract.test-support'
import { hookSpecFor } from '../hook-specs'
import { capabilityLine } from '../profile'
import { type HookBench, apply, hookBench, profile, writesOf } from './custom-hooks.test-support'
import { KIRO_MCP_FILE, kiroHooksFileActions, kiroHooksFileUninstallActions, kiroHooksPath } from './kiro'

let bench: HookBench
beforeEach(() => {
  bench = hookBench()
})
afterEach(async () => {
  await bench.cleanup()
})

const moved = (raw: Record<string, unknown>, root: string): Record<string, unknown> => ({ ...raw, cwd: root })

test('kiro: the hook prints nothing, since Kiro\'s docs confirm no hook output reaching the agent on these triggers', async () => {
  for (const file of ['docs-constructed-session-start.json', 'docs-constructed-user-prompt-submit.json', 'docs-constructed-post-tool-use.json', 'docs-constructed-stop.json', 'docs-constructed-session-end.json']) {
    expect(await bench.hook('kiro', file, moved)).toBeNull()
  }
  expect(bench.asked).toEqual([])
  expect(hookSpecFor('kiro')?.promptContext).toBeUndefined()
  expect(hookSpecFor('kiro')?.sessionContextIgnored).toBe(true)
})

test('kiro: a minimal payload is not captured and the hook stays silent', async () => {
  expect(await bench.hook('kiro', 'docs-constructed-stop.json', () => ({ hook_event_name: 'Stop' }))).toBeNull()
})

test('kiro: ~/.kiro/hooks/kinfold.json is a v1 hook file of command actions, and meets the writer contract', () => {
  const w = bench.world()
  const path = kiroHooksPath(w.env)
  expect(path).toBe(join(w.env.homeDir, '.kiro', 'hooks', 'kinfold.json'))
  const { write, remove } = fileWriter(path, () => kiroHooksFileActions(w.env), () => kiroHooksFileUninstallActions(w.env))
  assertWriterContract(write, remove, [null])
  const json = JSON.parse(write(null) ?? '{}')
  expect(json.version).toBe('v1')
  expect(json.hooks.map((hook: { trigger: string }) => hook.trigger)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'])
  expect(json.hooks[0]).toEqual({ name: 'kinfold SessionStart', trigger: 'SessionStart', action: { type: 'command', command: expect.stringContaining('--host kiro') }, timeout: 10 })
})

test('kiro: a kinfold.json that is not ours is left alone on install and uninstall', () => {
  const w = bench.world()
  const path = kiroHooksPath(w.env)
  mkdirSync(join(w.env.homeDir, '.kiro', 'hooks'), { recursive: true })
  const mine = JSON.stringify({ version: 'v1', hooks: [{ name: 'lint', trigger: 'Stop', action: { type: 'command', command: 'npm run lint' } }] })
  writeFileSync(path, mine)
  expect(kiroHooksFileActions(w.env)).toEqual([])
  expect(w.out.at(-1)).toContain('is not a Kinfold hook file; left alone')
  expect(kiroHooksFileUninstallActions(w.env)).toEqual([])
  expect(readFileSync(path, 'utf8')).toBe(mine)
})

test('kiro: the MCP entry in ~/.kiro/settings/mcp.json meets the writer contract', () => {
  const w = bench.world()
  const path = KIRO_MCP_FILE.path(w.env)
  expect(path).toBe(join(w.env.homeDir, '.kiro', 'settings', 'mcp.json'))
  const { write, remove } = fileWriter(path, () => jsonAgentFileInstallActions(w.env, 'kiro', KIRO_MCP_FILE), () => jsonAgentFileUninstallActions(w.env, 'kiro', KIRO_MCP_FILE))
  assertWriterContract(write, remove, [null, `${JSON.stringify({ mcpServers: { other: { command: 'npx' } } }, null, 2)}\n`])
  expect(JSON.parse(write(null) ?? '{}').mcpServers[MCP_SERVER_NAME].env).toEqual({ [MCP_HOST_ENV]: 'kiro' })
})

test('kiro: on Windows no hooks file is planned and the capability line says why', async () => {
  const kiro = profile('kiro')
  expect(kiro.capabilities('windows')).toEqual({ capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false })
  expect(capabilityLine(kiro, 'windows')).toStartWith('search only (no hooks on Windows')
  const w = bench.world('win32')
  expect(writesOf(await kiro.wiring.install(w.env))).toEqual([KIRO_MCP_FILE.path(w.env)])
})

test('kiro: built from the docs, captures without context, and the IDE\'s workspace path is a manual step', async () => {
  const kiro = profile('kiro')
  expect(kiro).toMatchObject({ id: 'kiro', verification: 'docs', detection: { binaries: ['kiro-cli'], bundles: ['Kiro.app'] } })
  expect(kiro.capabilities('macos')).toEqual({ capture: 'full', context: { sessionStart: false, prompt: false }, search: true, observer: false })
  expect(capabilityLine(kiro, 'macos')).toContain('only Kiro CLI V3 reads ~/.kiro/hooks')
  expect(kiro.manualSteps('macos', bench.world().env).join(' ')).toContain('.kiro/hooks/kinfold.json')
  const w = bench.world()
  apply(await kiro.wiring.install(w.env))
  expect(kiro.wiring.state(w.env)).toBe('yes')
  expect(await kiro.wiring.install(w.env)).toEqual([])
  expect(kiro.wiring.line(w.env)).toBe(`hooks yes in ${kiroHooksPath(w.env)}; MCP yes in ${KIRO_MCP_FILE.path(w.env)}`)
  apply(kiro.wiring.uninstall(w.env))
  expect(kiro.wiring.state(w.env)).toBe('no')
})
