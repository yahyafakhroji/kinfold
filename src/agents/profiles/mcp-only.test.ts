import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KNOWN_HOSTS } from '../../contract/event'
import { detectFromSpec } from '../../install/detect'
import { MCP_SERVER_NAME, claudeMcpEntry } from '../../install/mcp-config'
import { mcpPaths, mcpTarget } from '../../install/mcp-wiring'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import type { OsName } from '../../platform/platform'
import { jsonAgentFileInstallActions, jsonAgentFileUninstallActions } from '../families/json-agent'
import { assertWriterContract, fileWriter } from '../families/writer-contract.test-support'
import { HOOK_SPECS } from '../hook-specs'
import { INSTALL_PROFILES } from '../install-profiles'
import { capabilityLine } from '../profile'
import { type HookBench, apply, hookBench, profile, writesOf } from './custom-hooks.test-support'
import { WARP_MCP_FILE } from './warp'
import { ZED_MCP_FILE } from './zed'

let bench: HookBench
beforeEach(() => {
  bench = hookBench()
})
afterEach(async () => {
  await bench.cleanup()
})

const NONE = { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false } as const
const OSES: readonly OsName[] = ['macos', 'linux', 'windows']

test('zed and warp are search only on every OS, and continue (which writes nothing) claims no search, all built from the docs, with no hook spec', () => {
  const c = profile('continue')
  expect(c).toMatchObject({ id: 'continue', name: 'Continue', family: 'mcp-only', verification: 'docs' })
  expect(HOOK_SPECS.continue).toBeNull()
  for (const os of OSES) expect(c.capabilities(os)).toEqual({ ...NONE, search: false })
  for (const [id, name] of [['zed', 'Zed'], ['warp', 'Warp']] as const) {
    const p = profile(id)
    expect(p).toMatchObject({ id, name, family: 'mcp-only', verification: 'docs' })
    expect(HOOK_SPECS[id]).toBeNull()
    for (const os of OSES) {
      expect(p.capabilities(os)).toEqual(NONE)
      expect(capabilityLine(p, os)).toBe(`search only (${name} has no hooks${id === 'zed' && os === 'windows' ? '; add the entry by hand, no Windows settings path is documented' : ''})`)
    }
  }
})

test("zed: the entry lands under context_servers and meets the writer contract", () => {
  const w = bench.world()
  const path = ZED_MCP_FILE.path(w.env)
  expect(path).toBe(join(w.env.homeDir, '.config', 'zed', 'settings.json'))
  const { write, remove } = fileWriter(path, () => jsonAgentFileInstallActions(w.env, 'zed', ZED_MCP_FILE), () => jsonAgentFileUninstallActions(w.env, 'zed', ZED_MCP_FILE))
  assertWriterContract(write, remove, [null, `${JSON.stringify({ theme: 'One Dark', context_servers: { other: { command: 'x', args: [], env: {} } } }, null, 2)}\n`])
  const entry = JSON.parse(write(null) ?? '{}').context_servers[MCP_SERVER_NAME]
  expect(entry).toMatchObject({ env: { [MCP_HOST_ENV]: 'zed' } })
  expect(typeof entry.command).toBe('string')
  expect(Array.isArray(entry.args)).toBe(true)
})

test("zed: a JSONC settings file is refused untouched with the reason, and the manual step prints the exact entry", async () => {
  const w = bench.world()
  const path = ZED_MCP_FILE.path(w.env)
  mkdirSync(join(path, '..'), { recursive: true })
  const jsonc = '// my settings\n{ "theme": "One Dark", }\n'
  writeFileSync(path, jsonc)
  expect(await profile('zed').wiring.install(w.env)).toEqual([])
  expect(w.out.at(-1)).toContain('zed: skipped;')
  expect(w.out.at(-1)).toContain('not plain JSON')
  expect(readFileSync(path, 'utf8')).toBe(jsonc)
  expect(profile('zed').wiring.state(w.env)).toBe('unknown')
  const entry = ZED_MCP_FILE.mcp?.entry(mcpTarget(w.env), 'zed')
  expect(profile('zed').manualSteps('macos', w.env).join('\n')).toContain(`"${MCP_SERVER_NAME}": ${JSON.stringify(entry)}`)
})

test('zed: install writes on macOS and Linux, plans nothing on Windows (no documented path), and is idempotent', async () => {
  const zed = profile('zed')
  const w = bench.world()
  expect(writesOf(await zed.wiring.install(w.env))).toEqual([ZED_MCP_FILE.path(w.env)])
  apply(await zed.wiring.install(w.env))
  expect(zed.wiring.state(w.env)).toBe('yes')
  expect(await zed.wiring.install(w.env)).toEqual([])
  expect(zed.wiring.line(w.env)).toBe(`MCP yes in ${ZED_MCP_FILE.path(w.env)}`)
  apply(zed.wiring.uninstall(w.env))
  expect(zed.wiring.state(w.env)).toBe('no')

  const win = bench.world('win32')
  expect(await zed.wiring.install(win.env)).toEqual([])
  expect(win.out.at(-1)).toContain('zed:')
  expect(zed.wiring.line(win.env)).toContain('no Windows settings path')
  expect(zed.manualSteps('windows', win.env).join('\n')).toContain('context_servers')
})

test('zed: detected by the zed binary or Zed.app', () => {
  expect(profile('zed').detection).toEqual({ binaries: ['zed'], bundles: ['Zed.app'] })
})

test('continue: writes nothing, prints the exact YAML block, and detection finds nothing unless --hosts names it', async () => {
  const c = profile('continue')
  // Nothing is written, so search waits on the block the user adds.
  expect(c.capabilities('macos')).toMatchObject({ capture: 'none', search: false })
  expect(capabilityLine(c, 'macos')).toBe('Continue has no hooks; search needs the MCP block added to ~/.continue/config.yaml by hand')
  const w = bench.world()
  expect(await c.wiring.install(w.env)).toEqual([])
  expect(w.out.join('\n')).toContain('mcpServers:')
  expect(w.out.join('\n')).toContain('config.yaml')
  expect(c.wiring.uninstall(w.env)).toEqual([])
  expect(c.wiring.state(w.env)).toBe('no')
  const target = mcpTarget(w.env)
  const step = c.manualSteps('macos', w.env).join('\n')
  expect(step).toContain('mcpServers:')
  expect(step).toContain(`- name: ${MCP_SERVER_NAME}`)
  expect(step).toContain(`command: ${JSON.stringify(target.entry.command)}`)
  expect(step).toContain(`args: ${JSON.stringify(target.entry.args)}`)
  expect(step).toContain(`${MCP_HOST_ENV}: "continue"`)
  expect(step).toContain('config.yaml')
  expect(typeof c.detection).toBe('function')
  if (typeof c.detection !== 'function') return
  expect(await c.detection(w.env, false)).toMatchObject({ host: 'continue', selected: false })
  expect(await c.detection(w.env, true)).toMatchObject({ host: 'continue', selected: true })
})

test('warp: writes nothing when Claude Code is wired and status says which entry it uses', async () => {
  const warp = profile('warp')
  const w = bench.world()
  expect(warp.wiring.line(w.env)).not.toContain('uses the')
  writeFileSync(mcpPaths(w.env).claudeUserConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: claudeMcpEntry(mcpTarget(w.env)) } }))
  expect(await warp.wiring.install(w.env)).toEqual([])
  expect(w.out.at(-1)).toContain("uses the Claude Code entry (needs 'Auto-spawn")
  expect(warp.wiring.line(w.env)).toBe("uses the Claude Code entry (needs 'Auto-spawn servers from third-party agents' on in Warp)")
  expect(warp.wiring.state(w.env)).toBe('no')
  expect(warp.manualSteps('macos', w.env).join('\n')).toContain('Claude Code')
})

test("warp: otherwise it merges ~/.warp/.mcp.json and the manual step gives the Settings path and entry", async () => {
  const warp = profile('warp')
  const w = bench.world()
  const path = WARP_MCP_FILE.path(w.env)
  expect(path).toBe(join(w.env.homeDir, '.warp', '.mcp.json'))
  const { write, remove } = fileWriter(path, () => jsonAgentFileInstallActions(w.env, 'warp', WARP_MCP_FILE), () => jsonAgentFileUninstallActions(w.env, 'warp', WARP_MCP_FILE))
  assertWriterContract(write, remove, [null, `${JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['x'] } } }, null, 2)}\n`])
  expect(writesOf(await warp.wiring.install(w.env))).toEqual([path])
  apply(await warp.wiring.install(w.env))
  expect(warp.wiring.state(w.env)).toBe('yes')
  expect(await warp.wiring.install(w.env)).toEqual([])
  const step = warp.manualSteps('macos', w.env).join('\n')
  expect(step).toContain('Settings > Agents > MCP servers')
  expect(step).toContain(`"${MCP_SERVER_NAME}": ${JSON.stringify(WARP_MCP_FILE.mcp?.entry(mcpTarget(w.env), 'warp'))}`)
  apply(warp.wiring.uninstall(w.env))
  expect(warp.wiring.state(w.env)).toBe('no')
})

test('warp: a ~/.warp/.mcp.json that is not plain JSON is skipped untouched', async () => {
  const w = bench.world()
  const path = WARP_MCP_FILE.path(w.env)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '{ "mcpServers": {}, }')
  expect(await profile('warp').wiring.install(w.env)).toEqual([])
  expect(readFileSync(path, 'utf8')).toBe('{ "mcpServers": {}, }')
})

test('every agent has a profile, and a null hook spec means no hook command: capture none on every OS, or a plugin agent', () => {
  for (const id of KNOWN_HOSTS) expect(INSTALL_PROFILES[id]).not.toBeNull()
  const nullSpecs = KNOWN_HOSTS.filter((id) => HOOK_SPECS[id] === null)
  expect([...nullSpecs].sort()).toEqual(['continue', 'kilo-code', 'opencode', 'warp', 'zed'])
  for (const id of KNOWN_HOSTS) {
    const p = profile(id)
    const noneEverywhere = OSES.every((os) => p.capabilities(os).capture === 'none')
    const pluginAgent = p.family === 'opencode-plugin'
    expect(HOOK_SPECS[id] === null).toBe(noneEverywhere && p.family === 'mcp-only' || pluginAgent)
  }
})
