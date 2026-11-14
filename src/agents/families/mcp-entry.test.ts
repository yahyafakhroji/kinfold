import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MCP_SERVER_NAME } from '../../install/mcp-config'
import { mcpTarget } from '../../install/mcp-wiring'
import { type FakeWorld, createWorld } from '../../install/test-support'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import { type McpEntrySpec, mcpEntryActions, mcpEntryState, mcpEntryUninstallActions } from './mcp-entry'
import { assertWriterContract, fileWriter } from './writer-contract.test-support'

let worlds: FakeWorld[] = []
afterEach(async () => {
  for (const w of worlds) await w.cleanup()
  worlds = []
})

const SPEC: McpEntrySpec = {
  path: (env) => join(env.homeDir, '.gemini', 'settings.json'),
  key: 'mcpServers',
  entry: (target, host) => ({ command: target.entry.command, args: target.entry.args, env: { [MCP_HOST_ENV]: host } }),
}

const OTHER = { command: 'npx', args: ['-y', 'other-server'] }

function setup(text: string | null): { w: FakeWorld; path: string } {
  const w = createWorld()
  worlds.push(w)
  const path = SPEC.path(w.env)
  if (text !== null) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  return { w, path }
}

test('an MCP entry is added under the configured key, a re-run changes nothing, and removal restores the original bytes', () => {
  const userFile = `${JSON.stringify({ theme: 'dark', mcpServers: { other: OTHER } }, null, 2)}\n`
  const { w, path } = setup(userFile)
  const { write, remove } = fileWriter(path, () => mcpEntryActions(w.env, SPEC, 'gemini-cli'), () => mcpEntryUninstallActions(w.env, SPEC))
  const config = JSON.parse(write(userFile) ?? '{}')
  expect(config.theme).toBe('dark')
  expect(config.mcpServers.other).toEqual(OTHER)
  expect(config.mcpServers[MCP_SERVER_NAME]).toEqual(SPEC.entry(mcpTarget(w.env), 'gemini-cli'))
  expect(mcpEntryState(w.env, SPEC, 'gemini-cli')).toBe('yes')
  assertWriterContract(write, remove, [userFile])
  expect(w.out).toContain(`gemini-cli: MCP server already in ${path}`)
  for (const before of ['{"theme":"dark"}', null]) {
    const fresh = setup(null)
    const writer = fileWriter(fresh.path, () => mcpEntryActions(fresh.w.env, SPEC, 'gemini-cli'), () => mcpEntryUninstallActions(fresh.w.env, SPEC))
    assertWriterContract(writer.write, writer.remove, [before])
  }
})

test('an entry of ours that runs another path is stale and replaced; one under our name that is not ours is left alone', () => {
  const stale = { mcpServers: { [MCP_SERVER_NAME]: { command: '/old/bun', args: ['/old/checkout/src/mcp/server.ts'] } } }
  const { w, path } = setup(JSON.stringify(stale))
  expect(mcpEntryState(w.env, SPEC, 'gemini-cli')).toBe('stale')
  expect(mcpEntryActions(w.env, SPEC, 'gemini-cli').map((action) => action.kind)).toEqual(['backup', 'write'])
  writeFileSync(path, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: OTHER } }))
  expect(mcpEntryState(w.env, SPEC, 'gemini-cli')).toBe('foreign')
  expect(mcpEntryActions(w.env, SPEC, 'gemini-cli')).toEqual([])
  expect(mcpEntryUninstallActions(w.env, SPEC)).toEqual([])
  expect(w.out.at(-1)).toContain('not ours')
})

test('a config with comments is refused untouched, with "not plain JSON" in the reason', () => {
  const text = '{\n  "mcpServers": {}, // servers\n}\n'
  const { w, path } = setup(text)
  expect(mcpEntryActions(w.env, SPEC, 'gemini-cli')).toEqual([])
  expect(mcpEntryUninstallActions(w.env, SPEC)).toEqual([])
  expect(mcpEntryState(w.env, SPEC, 'gemini-cli')).toBe('unknown')
  expect(readFileSync(path, 'utf8')).toBe(text)
  expect(w.out.filter((line) => line.includes('not plain JSON'))).toHaveLength(2)
})
