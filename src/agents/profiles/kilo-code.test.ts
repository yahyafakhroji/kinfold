import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MCP_SERVER_NAME } from '../../install/mcp-config'
import { mcpTarget, opencodeMcpInstallActions } from '../../install/mcp-wiring'
import type { Action } from '../../install/plan'
import { type FakeWorld, createWorld } from '../../install/test-support'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import { assertWriterContract, fileWriter } from '../families/writer-contract.test-support'
import { jsonAgentFileInstallActions, jsonAgentFileUninstallActions } from '../families/json-agent'
import { profileOf } from '../install-profiles'
import { capabilityLine } from '../profile'
import { agentWiringActions } from '../../install/install'
import { KILO_CODE_PROFILE, KILO_MCP_FILE } from './kilo-code'

let worlds: FakeWorld[] = []
afterEach(async () => {
  for (const w of worlds) await w.cleanup()
  worlds = []
})
const world = (): FakeWorld => {
  const w = createWorld()
  worlds.push(w)
  return w
}
const apply = (actions: readonly Action[]): void => {
  for (const a of actions) {
    if (a.kind === 'mkdir') mkdirSync(a.path, { recursive: true })
    if (a.kind === 'write') writeFileSync(a.path, a.content)
  }
}
const writes = (actions: readonly Action[]): string[] => actions.flatMap((a) => (a.kind === 'write' ? [a.path] : []))

test('kilo-code is registered, built from the docs, and detected by its binary', () => {
  expect(profileOf('kilo-code')).toBe(KILO_CODE_PROFILE)
  expect(KILO_CODE_PROFILE.verification).toBe('docs')
  expect(KILO_CODE_PROFILE.detection).toEqual({ binaries: ['kilo'] })
  // No observer provider runs through Kilo; a new agent falls back to OpenRouter auto.
  expect(KILO_CODE_PROFILE.capabilities('macos').observer).toBe(false)
  expect(capabilityLine(KILO_CODE_PROFILE, 'macos')).toContain('no config-folder variable honoured')
  expect(capabilityLine(KILO_CODE_PROFILE, 'windows')).toContain('Windows config folder unverified')
  expect(KILO_CODE_PROFILE.manualSteps('macos', world().env).join(' ')).toContain('kilo.jsonc')
})

test('the MCP entry in kilo.json meets the writer contract and names its host', () => {
  const w = world()
  const path = KILO_MCP_FILE.path(w.env)
  expect(path).toBe(join(w.env.homeDir, '.config', 'kilo', 'kilo.json'))
  const { write, remove } = fileWriter(path, () => jsonAgentFileInstallActions(w.env, 'kilo-code', KILO_MCP_FILE), () => jsonAgentFileUninstallActions(w.env, 'kilo-code', KILO_MCP_FILE))
  const other = { theme: 'dark', mcp: { other: { type: 'local', command: ['npx', 'x'] } } }
  assertWriterContract(write, remove, [null, `${JSON.stringify(other, null, 2)}\n`])
  const json = JSON.parse(write(null) ?? '{}')
  expect(json.mcp[MCP_SERVER_NAME]).toMatchObject({ type: 'local', enabled: true, environment: { [MCP_HOST_ENV]: 'kilo-code' } })
  expect(Array.isArray(json.mcp[MCP_SERVER_NAME].command)).toBe(true)
})

test('install writes the plugin under ~/.config/kilo/plugin and the MCP entry in kilo.json', async () => {
  const w = world()
  const actions = await KILO_CODE_PROFILE.wiring.install(w.env)
  expect(writes(actions)).toEqual([join(w.env.homeDir, '.config/kilo/plugin/kinfold.js'), join(w.env.homeDir, '.config/kilo/kilo.json')])
  apply(actions)
  expect(readFileSync(join(w.env.homeDir, '.config/kilo/plugin/kinfold.js'), 'utf8')).toContain('globalThis.KINFOLD_HOST = "kilo-code";')
  expect(KILO_CODE_PROFILE.wiring.state(w.env)).toBe('yes')
  expect(await KILO_CODE_PROFILE.wiring.install(w.env)).toEqual([])
  expect(KILO_CODE_PROFILE.wiring.line(w.env)).toContain('MCP yes in')
})

test('Kilo gets its own MCP entry even when opencode.json already has Kinfold\'s, and a re-run plans nothing', async () => {
  const w = world()
  apply(opencodeMcpInstallActions(w.env))
  const actions = await KILO_CODE_PROFILE.wiring.install(w.env)
  expect(writes(actions)).toEqual([join(w.env.homeDir, '.config/kilo/plugin/kinfold.js'), join(w.env.homeDir, '.config/kilo/kilo.json')])
  apply(actions)
  expect(await KILO_CODE_PROFILE.wiring.install(w.env)).toEqual([])
  expect(KILO_CODE_PROFILE.wiring.line(w.env)).toContain('MCP yes in')
})

test('with a kilo.jsonc present, no kilo.json is created and the reason is printed', async () => {
  const w = world()
  mkdirSync(join(w.env.homeDir, '.config/kilo'), { recursive: true })
  writeFileSync(join(w.env.homeDir, '.config/kilo/kilo.jsonc'), '{ // mine\n}\n')
  const actions = await KILO_CODE_PROFILE.wiring.install(w.env)
  expect(writes(actions)).toEqual([join(w.env.homeDir, '.config/kilo/plugin/kinfold.js')])
  expect(w.out.some((line) => line.includes('kilo.jsonc found; add the kinfold MCP entry there by hand'))).toBe(true)
  expect(KILO_CODE_PROFILE.wiring.line(w.env)).toContain('kilo.jsonc found')
})

test('uninstall removes only the plugin file and mcp.kinfold, keeping other entries', async () => {
  const w = world()
  const cfg = join(w.env.homeDir, '.config/kilo/kilo.json')
  mkdirSync(join(w.env.homeDir, '.config/kilo'), { recursive: true })
  writeFileSync(cfg, JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local', command: ['npx', 'x'] } } }, null, 2))
  apply(await KILO_CODE_PROFILE.wiring.install(w.env))
  expect(JSON.parse(readFileSync(cfg, 'utf8')).mcp[MCP_SERVER_NAME]).toBeDefined()
  const plugin = join(w.env.homeDir, '.config/kilo/plugin/kinfold.js')
  const actions = KILO_CODE_PROFILE.wiring.uninstall(w.env)
  expect(actions.flatMap((a) => (a.kind === 'remove' ? [a.path] : []))).toEqual([plugin])
  for (const a of actions) {
    if (a.kind === 'remove') rmSync(a.path)
    if (a.kind === 'write') writeFileSync(a.path, a.content)
  }
  expect(existsSync(plugin)).toBe(false)
  expect(JSON.parse(readFileSync(cfg, 'utf8'))).toEqual({ theme: 'dark', mcp: { other: { type: 'local', command: ['npx', 'x'] } } })
})

test('a kinfold.js in Kilo\'s plugin folder that is not ours skips Kilo\'s plugin with the reason, and the rest still installs', async () => {
  const w = world()
  const plugin = join(w.env.homeDir, '.config/kilo/plugin/kinfold.js')
  mkdirSync(join(w.env.homeDir, '.config/kilo/plugin'), { recursive: true })
  writeFileSync(plugin, 'export default {}\n')
  const actions = await KILO_CODE_PROFILE.wiring.install(w.env)
  expect(writes(actions)).toEqual([join(w.env.homeDir, '.config/kilo/kilo.json')])
  expect(w.out.some((line) => line.startsWith('kilo-code: plugin skipped;') && line.includes('is not a Kinfold plugin file'))).toBe(true)
  expect(readFileSync(plugin, 'utf8')).toBe('export default {}\n')
  const all = await agentWiringActions(w.env, ['claude-code', 'kilo-code'])
  expect(writes(all)).toContain(join(w.env.homeDir, '.config/kilo/kilo.json'))
  expect(writes(all).some((path) => path.endsWith('settings.json'))).toBe(true)
})

test('kilo-code: the kilo.jsonc step prints the MCP entry install would write', () => {
  const w = world()
  const entry = KILO_MCP_FILE.mcp?.entry(mcpTarget(w.env), 'kilo-code')
  expect(KILO_CODE_PROFILE.manualSteps('macos', w.env).join(' ')).toContain(`"${MCP_SERVER_NAME}": ${JSON.stringify(entry)}`)
})
