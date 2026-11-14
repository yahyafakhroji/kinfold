import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MCP_SERVER_NAME } from '../../install/mcp-config'
import { mcpTarget } from '../../install/mcp-wiring'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import { posixOnly } from '../../../test/platform-guards'
import { jsonAgentFileInstallActions, jsonAgentFileUninstallActions } from '../families/json-agent'
import { assertWriterContract, fileWriter } from '../families/writer-contract.test-support'
import { hookSpecFor } from '../hook-specs'
import { capabilityLine } from '../profile'
import { CLINE_MCP_FILE, clineHookFileActions, clineHookFileUninstallActions, clineHooksDir } from './cline'
import { type HookBench, apply, hookBench, profile, writesOf } from './custom-hooks.test-support'

let bench: HookBench
beforeEach(() => {
  bench = hookBench()
})
afterEach(async () => {
  await bench.cleanup()
})

const moved = (raw: Record<string, unknown>, root: string): Record<string, unknown> => ({ ...raw, workspaceRoots: [root] })
const injected = JSON.stringify({ cancel: false, contextModification: '<kinfold>pack</kinfold>' })

test('cline: the hook prints nothing on an event the agent can\'t take context for', async () => {
  for (const file of ['docs-constructed-vscode-post-tool-use.json', 'docs-constructed-vscode-task-complete.json', 'docs-constructed-cli-tool-result.json', 'docs-constructed-cli-session-shutdown.json']) {
    expect(await bench.hook('cline', file, moved)).toBeNull()
  }
  expect(bench.asked).toEqual([])
  expect(bench.asked).toEqual([])
})

test('cline: two TaskStarts for one task print nothing, and UserPromptSubmit still gets the delta', async () => {
  // The extension may fire TaskStart on every turn, so no session-start pack is asked for.
  expect(await bench.hook('cline', 'docs-constructed-vscode-task-start.json', moved)).toBeNull()
  expect(await bench.hook('cline', 'docs-constructed-vscode-task-start.json', moved)).toBeNull()
  expect(await bench.hook('cline', 'docs-constructed-cli-agent-start.json', moved)).toBeNull()
  expect(bench.asked).toEqual([])
  expect(await bench.hook('cline', 'docs-constructed-vscode-user-prompt-submit.json', moved)).toBe(injected)
  expect(bench.asked.map((request) => request.channel)).toEqual(['prompt'])
})

test('cline: a minimal payload is not captured and the hook stays silent', async () => {
  const w = bench.world()
  expect(await bench.hook('cline', 'docs-constructed-vscode-task-start.json', (raw) => ({ hookName: raw.hookName }))).toBeNull()
  expect(bench.asked).toEqual([])
  expect(w.out).toEqual([])
})

// The worlds below are POSIX ones, and a hook file counts as current only while
// it keeps its exec bits, which a Windows file system doesn't hold.
posixOnly('file modes')('the Cline hook file is executable (0755 on POSIX) and runs kinfold hook --host cline', () => {
  const w = bench.world()
  const actions = clineHookFileActions(w.env)
  const dir = join(w.env.homeDir, 'Documents', 'Cline', 'Hooks')
  expect(clineHooksDir(w.env)).toBe(dir)
  expect(writesOf(actions)).toEqual(['TaskStart', 'UserPromptSubmit', 'PostToolUse', 'TaskComplete', 'TaskCancel', 'SessionShutdown'].map((name) => join(dir, name)))
  const write = actions.find((action) => action.kind === 'write')
  if (write?.kind !== 'write') throw new Error('no write planned')
  expect(write.mode).toBe(0o755)
  const lines = write.content.split('\n')
  expect(lines[0]).toBe('#!/bin/sh')
  expect(lines.at(-2)).toStartWith('exec ')
  expect(lines.at(-2)).toEndWith(' --host cline')
  apply(actions)
  expect(statSync(join(dir, 'TaskStart')).mode & 0o777).toBe(0o755)
  expect(clineHookFileActions(w.env)).toEqual([])
  expect(profile('cline').wiring.state(w.env)).toBe('yes')
})

posixOnly('file modes')('cline: each hook file meets the writer contract, and a file by our name that is not ours is left alone', () => {
  const w = bench.world()
  const path = join(clineHooksDir(w.env), 'TaskStart')
  const { write, remove } = fileWriter(path, () => clineHookFileActions(w.env), () => clineHookFileUninstallActions(w.env))
  assertWriterContract(write, remove, [null])

  mkdirSync(clineHooksDir(w.env), { recursive: true })
  writeFileSync(path, '#!/bin/sh\necho mine\n')
  const actions = clineHookFileActions(w.env)
  expect(writesOf(actions)).not.toContain(path)
  expect(w.out.some((line) => line.includes(`${path} is not a Kinfold hook file; left alone`))).toBe(true)
  apply(actions)
  expect(clineHookFileUninstallActions(w.env).flatMap((action) => (action.kind === 'remove' ? [action.path] : []))).not.toContain(path)
  expect(readFileSync(path, 'utf8')).toBe('#!/bin/sh\necho mine\n')
  expect(profile('cline').wiring.state(w.env)).toBe('partial')
})

test('cline: the MCP entry in the CLI settings file meets the writer contract and honours CLINE_MCP_SETTINGS_PATH', () => {
  const w = bench.world()
  const path = CLINE_MCP_FILE.path(w.env)
  expect(path).toBe(join(w.env.homeDir, '.cline', 'data', 'settings', 'cline_mcp_settings.json'))
  const { write, remove } = fileWriter(path, () => jsonAgentFileInstallActions(w.env, 'cline', CLINE_MCP_FILE), () => jsonAgentFileUninstallActions(w.env, 'cline', CLINE_MCP_FILE))
  assertWriterContract(write, remove, [null, `${JSON.stringify({ mcpServers: { other: { command: 'npx' } } }, null, 2)}\n`])
  const json = JSON.parse(write(null) ?? '{}')
  expect(json.mcpServers[MCP_SERVER_NAME]).toMatchObject({ disabled: false, env: { [MCP_HOST_ENV]: 'cline' } })

  const moved = { ...w.env, clineMcpSettingsPathEnv: join(w.root, 'mine.json') }
  expect(CLINE_MCP_FILE.path(moved)).toBe(join(w.root, 'mine.json'))
})

test('cline capabilities on windows are search only and install writes no hook files there', async () => {
  const cline = profile('cline')
  expect(cline.capabilities('windows')).toEqual({ capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false })
  expect(capabilityLine(cline, 'windows')).toBe('search only (Cline\'s hooks don\'t run on Windows)')
  const w = bench.world('win32')
  const actions = await cline.wiring.install(w.env)
  expect(writesOf(actions)).toEqual([CLINE_MCP_FILE.path(w.env)])
  apply(actions)
  expect(cline.wiring.state(w.env)).toBe('yes')
  expect(cline.wiring.line(w.env)).toBe(`MCP yes in ${CLINE_MCP_FILE.path(w.env)}`)
  apply(cline.wiring.uninstall(w.env))
  expect(cline.wiring.state(w.env)).toBe('no')
  expect(cline.manualSteps('windows', bench.world('win32').env).join(' ')).not.toContain('Enable Hooks')
})

test('cline: built from the docs, context on each prompt only on POSIX, and Enable Hooks is a manual step', () => {
  const cline = profile('cline')
  expect(cline).toMatchObject({ id: 'cline', verification: 'docs', detection: { binaries: ['cline'] } })
  expect(cline.capabilities('macos')).toEqual({ capture: 'full', context: { sessionStart: false, prompt: true }, search: true, observer: false })
  expect(capabilityLine(cline, 'macos')).toStartWith('captures, context on each prompt, search (')
  expect(capabilityLine(cline, 'macos')).toContain('session-start context is off until a live run confirms TaskStart fires once per task; TaskStart may be recorded on every turn')
  expect(capabilityLine(cline, 'macos')).toContain('the Cline CLI runs UserPromptSubmit without reading its output')
  expect(cline.manualSteps('macos', bench.world().env).join(' ')).toContain('Enable Hooks')
  expect(hookSpecFor('cline')).not.toBeNull()
})

posixOnly('file modes')('cline: on POSIX install writes the hook files and the MCP entry, and uninstall removes them', async () => {
  const cline = profile('cline')
  const w = bench.world()
  apply(await cline.wiring.install(w.env))
  expect(cline.wiring.line(w.env)).toBe(`hooks yes in ${clineHooksDir(w.env)}; MCP yes in ${CLINE_MCP_FILE.path(w.env)}`)
  apply(cline.wiring.uninstall(w.env))
  expect(cline.wiring.state(w.env)).toBe('no')
})

test('cline: the VS Code MCP step prints the entry install would write', () => {
  const w = bench.world()
  const entry = CLINE_MCP_FILE.mcp?.entry(mcpTarget(w.env), 'cline')
  expect(profile('cline').manualSteps('macos', w.env).join(' ')).toContain(`"${MCP_SERVER_NAME}": ${JSON.stringify(entry)}`)
})
