import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MCP_SERVER_NAME } from '../../install/mcp-config'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import { jsonAgentFileInstallActions, jsonAgentFileUninstallActions } from '../families/json-agent'
import { assertWriterContract, fileWriter } from '../families/writer-contract.test-support'
import { hookSpecFor } from '../hook-specs'
import { capabilityLine } from '../profile'
import { AUGGIE_FILE } from './auggie'
import { type HookBench, apply, hookBench, profile, writesOf } from './custom-hooks.test-support'

let bench: HookBench
beforeEach(() => {
  bench = hookBench()
})
afterEach(async () => {
  await bench.cleanup()
})

const moved = (raw: Record<string, unknown>, root: string): Record<string, unknown> => ({ ...raw, cwd: root, workspace_roots: [root] })

// A user's own hook and MCP server, in the docs' shape.
const USER_SETTINGS = `${JSON.stringify({
  model: 'sonnet',
  hooks: { PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: '/etc/augment/hooks/validate-command.sh', timeout: 5000 }] }] },
  mcpServers: { 'local-tool': { command: '/usr/local/bin/custom-mcp', args: ['--serve'] } },
}, null, 2)}\n`

test('auggie: the hook prints nothing on session start and prompt, nor on any other event', async () => {
  for (const file of ['docs-constructed-session-start.json', 'docs-prompt-submit.json', 'docs-constructed-post-tool-use.json', 'docs-stop.json', 'docs-constructed-session-end.json']) {
    expect(await bench.hook('auggie', file, moved)).toBeNull()
  }
  expect(bench.asked).toEqual([])
  expect(hookSpecFor('auggie')).toMatchObject({ sessionContextIgnored: true })
  expect(hookSpecFor('auggie')?.promptContext).toBeUndefined()
})

test('auggie: a minimal payload is not captured and the hook stays silent', async () => {
  expect(await bench.hook('auggie', 'docs-constructed-session-start.json', (raw) => ({ hook_event_name: raw.hook_event_name }))).toBeNull()
  expect(bench.asked).toEqual([])
})

test('auggie: hooks and the MCP server in settings.json meet the writer contract in one write, around a user\'s own entries', () => {
  const w = bench.world()
  const path = AUGGIE_FILE.path(w.env)
  expect(path).toBe(join(w.env.homeDir, '.augment', 'settings.json'))
  const install = () => jsonAgentFileInstallActions(w.env, 'auggie', AUGGIE_FILE)
  const { write, remove } = fileWriter(path, install, () => jsonAgentFileUninstallActions(w.env, 'auggie', AUGGIE_FILE))
  assertWriterContract(write, remove, [null, USER_SETTINGS])

  const json = JSON.parse(write(USER_SETTINGS) ?? '{}')
  expect(Object.keys(json.hooks)).toEqual(['PreToolUse', 'SessionStart', 'PromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'])
  // args run the hook without a shell, and Auggie counts the timeout in milliseconds.
  const entry = json.hooks.PostToolUse[0].hooks[0]
  expect(entry).toMatchObject({ type: 'command', timeout: 10_000 })
  expect(entry.args.slice(-2)).toEqual(['--host', 'auggie'])
  expect(json.hooks.PostToolUse[0].matcher).toBeUndefined()
  expect(json.mcpServers[MCP_SERVER_NAME].env).toEqual({ [MCP_HOST_ENV]: 'auggie' })
  expect(json.mcpServers['local-tool']).toBeDefined()
  expect(writesOf(install())).toEqual([])
})

test('auggie: a settings.json that is not plain JSON is skipped with the reason and left untouched', async () => {
  const w = bench.world()
  const path = AUGGIE_FILE.path(w.env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '{ "model": "sonnet", }\n')
  expect(await profile('auggie').wiring.install(w.env)).toEqual([])
  expect(w.out.at(-1)).toContain('auggie: skipped;')
  expect(w.out.at(-1)).toContain('not plain JSON')
  expect(readFileSync(path, 'utf8')).toBe('{ "model": "sonnet", }\n')
})

test('auggie: on Windows the hooks are still written, since args run without a shell', async () => {
  const auggie = profile('auggie')
  expect(auggie.capabilities('windows')).toEqual(auggie.capabilities('macos'))
  const w = bench.world('win32')
  const json = JSON.parse((await auggie.wiring.install(w.env)).flatMap((action) => (action.kind === 'write' ? [action.content] : []))[0] ?? '{}')
  expect(Object.keys(json.hooks)).toEqual(['SessionStart', 'PromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'])
})

test('auggie: built from the docs, captures without context, and a full install is idempotent', async () => {
  const auggie = profile('auggie')
  expect(auggie).toMatchObject({ id: 'auggie', verification: 'docs', detection: { binaries: ['auggie'] } })
  expect(auggie.capabilities('linux')).toEqual({ capture: 'full', context: { sessionStart: false, prompt: false }, search: true, observer: false })
  expect(capabilityLine(auggie, 'linux')).toStartWith('captures, search (')
  expect(capabilityLine(auggie, 'linux')).toContain('no context is injected')
  expect(auggie.manualSteps('linux', bench.world('linux').env).join(' ')).toContain('--augment-cache-dir')
  const w = bench.world()
  apply(await auggie.wiring.install(w.env))
  expect(auggie.wiring.state(w.env)).toBe('yes')
  expect(await auggie.wiring.install(w.env)).toEqual([])
  expect(auggie.wiring.line(w.env)).toBe(`hooks yes, MCP yes in ${AUGGIE_FILE.path(w.env)}`)
  apply(auggie.wiring.uninstall(w.env))
  expect(auggie.wiring.state(w.env)).toBe('no')
})
