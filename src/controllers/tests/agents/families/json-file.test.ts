import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MCP_SERVER_NAME } from '../../install/mcp-config'
import { mcpTarget } from '../../install/mcp-wiring'
import { type FakeWorld, createWorld } from '../../install/test-support'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import { plainJsonFileActions, plainJsonFileUninstallActions } from './json-file'
import { type JsonHooksSpec, hookTarget, jsonHooksEdit, jsonHooksRemoveEdit } from './json-hooks'
import { type McpEntrySpec, mcpEntryEdit, mcpEntryRemoveEdit } from './mcp-entry'
import { assertWriterContract, fileWriter } from './writer-contract.test-support'

let worlds: FakeWorld[] = []
afterEach(async () => {
  for (const w of worlds) await w.cleanup()
  worlds = []
})

const HOOKS: JsonHooksSpec = { shape: 'gemini', events: ['SessionStart', 'AfterTool'], hooksKey: 'hooks', timeoutS: 10, host: 'gemini-cli' }
const MCP: McpEntrySpec = {
  path: (env) => join(env.homeDir, '.gemini', 'settings.json'),
  key: 'mcpServers',
  entry: (target, host) => ({ command: target.entry.command, args: target.entry.args, env: { [MCP_HOST_ENV]: host } }),
}

function setup(): { w: FakeWorld; path: string } {
  const w = createWorld()
  worlds.push(w)
  return { w, path: MCP.path(w.env) }
}

const installEdits = (w: FakeWorld) => [jsonHooksEdit(HOOKS, hookTarget(w.env, 'gemini-cli'), 'gemini-cli'), mcpEntryEdit(MCP, mcpTarget(w.env), 'gemini-cli')]
const removeEdits = [jsonHooksRemoveEdit(HOOKS), mcpEntryRemoveEdit(MCP)]

test('hooks and an MCP entry in one file are one backup and one write holding both', () => {
  const { w, path } = setup()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '{"theme":"dark"}')
  const actions = plainJsonFileActions(w.env, path, installEdits(w), 'gemini-cli')
  expect(actions.map((action) => action.kind)).toEqual(['backup', 'write'])
  const write = actions[1]
  const config = JSON.parse(write?.kind === 'write' ? write.content : '{}')
  expect(Object.keys(config.hooks)).toEqual(['SessionStart', 'AfterTool'])
  expect(config.mcpServers[MCP_SERVER_NAME]).toEqual(MCP.entry(mcpTarget(w.env), 'gemini-cli'))
  expect(config.theme).toBe('dark')
})

test('install twice then uninstall, both edits through one file, gives back the original bytes', () => {
  for (const before of ['{"theme":"dark"}', `${JSON.stringify({ mcpServers: { other: { command: 'npx' } } }, null, 2)}\n`, null]) {
    const { w, path } = setup()
    const { write, remove } = fileWriter(
      path,
      () => plainJsonFileActions(w.env, path, installEdits(w), 'gemini-cli'),
      () => plainJsonFileUninstallActions(w.env, path, removeEdits, 'gemini-cli'),
    )
    assertWriterContract(write, remove, [before])
    expect(w.out).toContain(`gemini-cli: hooks already wired in ${path}`)
    expect(w.out).toContain(`gemini-cli: MCP server already in ${path}`)
  }
})

test('an edit that refuses skips the whole file untouched, with the reason', () => {
  const { w, path } = setup()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '{"hooks": []}')
  expect(plainJsonFileActions(w.env, path, installEdits(w), 'gemini-cli')).toEqual([])
  expect(readFileSync(path, 'utf8')).toBe('{"hooks": []}')
  expect(w.out.at(-1)).toContain('gemini-cli: skipped;')
  const refusing = () => ({ refuse: 'the agent says no' })
  expect(plainJsonFileActions(w.env, path, [refusing], 'gemini-cli')).toEqual([])
  expect(w.out.at(-1)).toBe('gemini-cli: skipped; the agent says no')
})
