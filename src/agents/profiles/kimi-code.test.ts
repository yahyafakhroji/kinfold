import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MCP_SERVER_NAME } from '../../install/mcp-config'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import { jsonAgentFileInstallActions, jsonAgentFileUninstallActions } from '../families/json-agent'
import { assertWriterContract, fileWriter } from '../families/writer-contract.test-support'
import { hookSpecFor } from '../hook-specs'
import { capabilityLine } from '../profile'
import { type HookBench, apply, hookBench, profile, writesOf } from './custom-hooks.test-support'
import { KIMI_MCP_FILE, kimiConfigPath, kimiHooksActions, kimiHooksUninstallActions } from './kimi-code'

let bench: HookBench
beforeEach(() => {
  bench = hookBench()
})
afterEach(async () => {
  await bench.cleanup()
})

const moved = (raw: Record<string, unknown>, root: string): Record<string, unknown> => ({ ...raw, cwd: root })

// The hooks page's own example, with a user's settings around it.
const USER_CONFIG = `default_model = "kimi-code/k3"

[[hooks]]
event = "Notification"           # Trigger: when a background task status changes
matcher = "task\\\\.completed"     # Only care about "completed" notifications
command = "terminal-notifier -title Kimi -message 'Task done'"
`

test('kimi-code: the prompt delta goes back as plain stdout, and nothing is printed where Kimi ignores it', async () => {
  for (const file of ['docs-constructed-session-start.json', 'docs-constructed-post-tool-use.json', 'docs-constructed-stop.json', 'docs-constructed-interrupt.json', 'docs-constructed-session-end.json']) {
    expect(await bench.hook('kimi-code', file, moved)).toBeNull()
  }
  expect(bench.asked).toEqual([])
  expect(await bench.hook('kimi-code', 'docs-constructed-user-prompt-submit.json', moved)).toBe('<kinfold>pack</kinfold>')
  expect(bench.asked.map((request) => request.channel)).toEqual(['prompt'])
})

test('kimi-code: a minimal payload is not captured and the hook stays silent', async () => {
  expect(await bench.hook('kimi-code', 'docs-constructed-user-prompt-submit.json', () => ({ hook_event_name: 'UserPromptSubmit', prompt: 'x' }))).toBeNull()
  expect(bench.asked).toEqual([])
})

test('kimi-code: [[hooks]] in config.toml meet the writer contract, around a user\'s own hooks', () => {
  const w = bench.world()
  const path = kimiConfigPath(w.env)
  expect(path).toBe(join(w.env.homeDir, '.kimi-code', 'config.toml'))
  const { write, remove } = fileWriter(path, () => kimiHooksActions(w.env), () => kimiHooksUninstallActions(w.env))
  assertWriterContract(write, remove, [null, USER_CONFIG])
  const text = write(USER_CONFIG) ?? ''
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Interrupt', 'SessionEnd']) expect(text).toContain(`[[hooks]]\nevent = "${event}"\n`)
  expect(text).toContain('--host kimi-code"\ntimeout = 10\n')
})

test('kimi-code: a config.toml outside the TOML Kinfold reads is skipped with the reason and left untouched', () => {
  const w = bench.world()
  const path = kimiConfigPath(w.env)
  mkdirSync(join(w.env.homeDir, '.kimi-code'), { recursive: true })
  writeFileSync(path, 'server = { command = "x" }\n')
  expect(kimiHooksActions(w.env)).toEqual([])
  expect(w.out.at(-1)).toContain(`kimi-code: skipped; ${path}`)
})

test('kimi-code: with only config.toml refused, the line says the hooks were skipped and the MCP entry written', async () => {
  const w = bench.world()
  const path = kimiConfigPath(w.env)
  mkdirSync(join(w.env.homeDir, '.kimi-code'), { recursive: true })
  writeFileSync(path, 'server = { command = "x" }\n')
  const actions = await profile('kimi-code').wiring.install(w.env)
  expect(writesOf(actions)).toEqual([KIMI_MCP_FILE.path(w.env)])
  const line = w.out.find((each) => each.startsWith('kimi-code: hooks skipped ('))
  expect(line).toStartWith(`kimi-code: hooks skipped (${path} uses TOML Kinfold does not read`)
  expect(line).toEndWith('); MCP written')
  expect(w.out.some((each) => each.startsWith('kimi-code: skipped;'))).toBe(false)
})

test('kimi-code: the MCP entry goes in mcp.json and meets the writer contract', () => {
  const w = bench.world()
  const path = KIMI_MCP_FILE.path(w.env)
  expect(path).toBe(join(w.env.homeDir, '.kimi-code', 'mcp.json'))
  const { write, remove } = fileWriter(path, () => jsonAgentFileInstallActions(w.env, 'kimi-code', KIMI_MCP_FILE), () => jsonAgentFileUninstallActions(w.env, 'kimi-code', KIMI_MCP_FILE))
  assertWriterContract(write, remove, [null, `${JSON.stringify({ mcpServers: { other: { command: 'npx' } } }, null, 2)}\n`])
  expect(JSON.parse(write(null) ?? '{}').mcpServers[MCP_SERVER_NAME].env).toEqual({ [MCP_HOST_ENV]: 'kimi-code' })
})

test('kimi-code: KIMI_CODE_HOME moves both files, and an unusable one skips Kimi with the reason', async () => {
  const w = bench.world()
  const dir = join(w.root, 'kimi-home')
  mkdirSync(dir)
  w.env = { ...w.env, kimiCodeHomeEnv: dir }
  const real = realpathSync(dir)
  expect(writesOf(await profile('kimi-code').wiring.install(w.env))).toEqual([join(real, 'config.toml'), join(real, 'mcp.json')])
  expect(w.out).toContain(`kimi-code: KIMI_CODE_HOME is set; using ${real}`)

  const missing = bench.world()
  missing.env = { ...missing.env, kimiCodeHomeEnv: 'nowhere' }
  expect(await profile('kimi-code').wiring.install(missing.env)).toEqual([])
  expect(missing.out.at(-1)).toContain('kimi-code: KIMI_CODE_HOME points to "nowhere", but that path does not exist; nothing was wired')
  expect(profile('kimi-code').wiring.state(missing.env)).toBe('unknown')
})

test('kimi-code: on Windows no hooks are planned and the capability line says why', async () => {
  const kimi = profile('kimi-code')
  expect(kimi.capabilities('windows')).toEqual({ capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false })
  expect(capabilityLine(kimi, 'windows')).toStartWith('search only (no hooks on Windows')
  const w = bench.world('win32')
  expect(writesOf(await kimi.wiring.install(w.env))).toEqual([KIMI_MCP_FILE.path(w.env)])
})

test('kimi-code: built from the docs, context on each prompt only, and a full install is idempotent', async () => {
  const kimi = profile('kimi-code')
  expect(kimi).toMatchObject({ id: 'kimi-code', verification: 'docs', detection: { binaries: ['kimi'] } })
  expect(kimi.capabilities('macos')).toEqual({ capture: 'full', context: { sessionStart: false, prompt: true }, search: true, observer: false })
  expect(hookSpecFor('kimi-code')?.sessionContextIgnored).toBe(true)
  const w = bench.world()
  apply(await kimi.wiring.install(w.env))
  expect(kimi.wiring.state(w.env)).toBe('yes')
  expect(await kimi.wiring.install(w.env)).toEqual([])
  expect(kimi.wiring.line(w.env)).toBe(`hooks yes in ${kimiConfigPath(w.env)}; MCP yes in ${KIMI_MCP_FILE.path(w.env)}`)
  apply(kimi.wiring.uninstall(w.env))
  expect(kimi.wiring.state(w.env)).toBe('no')
})
