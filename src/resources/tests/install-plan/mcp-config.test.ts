import { expect, test } from 'bun:test'
import { MCP_SERVER_NAME, claudeMcpEntry, inspectMcpEntry, mcpServerScript, mergeMcpEntry, openCodeMcpEntry, removeMcpEntry } from './mcp-config'

const TARGET = { bunPath: '/Users/dev/.bun/bin/bun', serverScript: '/Users/dev/sam/src/mcp/server.ts', entry: { command: '/Users/dev/.bun/bin/bun', args: ['/Users/dev/sam/src/mcp/server.ts'] } }
const OLD = { bunPath: '/Users/dev/.bun/bin/bun', serverScript: '/Users/dev/old-checkout/src/mcp/server.ts', entry: { command: '/Users/dev/.bun/bin/bun', args: ['/Users/dev/old-checkout/src/mcp/server.ts'] } }
const FOREIGN_CLAUDE = { type: 'stdio', command: 'npx', args: ['-y', 'some-server'] }
const FOREIGN_OPENCODE = { type: 'local', command: ['node', '/x/claude-mem/mcp-server.cjs'] }

const claudeConfig = () => ({ numStartups: 4, projects: { '/a': { allowedTools: [] } }, mcpServers: { other: FOREIGN_CLAUDE } })
const openCodeConfig = () => ({ $schema: 'https://opencode.ai/config.json', theme: 'tokyonight', mcp: { 'claude-mem': FOREIGN_OPENCODE } })

test('entries have each host\'s shape with absolute paths', () => {
  expect(claudeMcpEntry(TARGET)).toEqual({ type: 'stdio', command: TARGET.bunPath, args: [TARGET.serverScript], env: { KINFOLD_MCP_HOST: 'claude-code' } })
  expect(openCodeMcpEntry(TARGET)).toEqual({
    type: 'local', command: [TARGET.bunPath, TARGET.serverScript], enabled: true, environment: { KINFOLD_MCP_HOST: 'opencode' },
  })
  expect(mcpServerScript(claudeMcpEntry(TARGET))).toBe(TARGET.serverScript)
  expect(mcpServerScript(openCodeMcpEntry(TARGET))).toBe(TARGET.serverScript)
  expect(mcpServerScript(FOREIGN_CLAUDE)).toBeNull()
  expect(mcpServerScript({ command: '/usr/bin/node', args: ['/a/src/mcp/server.ts'] })).toBeNull()
})

test('merge into Claude Code config keeps every foreign server and key', () => {
  const merged = mergeMcpEntry(claudeConfig(), 'claude-code', TARGET)
  expect(merged.changed).toBe(true)
  expect(merged.config).toEqual({ ...claudeConfig(), mcpServers: { other: FOREIGN_CLAUDE, [MCP_SERVER_NAME]: claudeMcpEntry(TARGET) } })
  const again = mergeMcpEntry(merged.config, 'claude-code', TARGET)
  expect(again.changed).toBe(false)
  expect(again.config).toBe(merged.config)
  expect(inspectMcpEntry(merged.config, 'claude-code', TARGET)).toBe('yes')
})

test('merge into OpenCode config keeps every foreign server and key, and creates the section when missing', () => {
  const merged = mergeMcpEntry(openCodeConfig(), 'opencode', TARGET)
  expect(merged.config).toEqual({ ...openCodeConfig(), mcp: { 'claude-mem': FOREIGN_OPENCODE, [MCP_SERVER_NAME]: openCodeMcpEntry(TARGET) } })
  expect(mergeMcpEntry({ theme: 'x' }, 'opencode', TARGET).config).toEqual({ theme: 'x', mcp: { [MCP_SERVER_NAME]: openCodeMcpEntry(TARGET) } })
})

test('a moved checkout replaces the stale entry', () => {
  const stale = mergeMcpEntry(claudeConfig(), 'claude-code', OLD).config
  expect(inspectMcpEntry(stale, 'claude-code', TARGET)).toBe('stale')
  const fixed = mergeMcpEntry(stale, 'claude-code', TARGET)
  expect(fixed).toMatchObject({ changed: true, state: 'stale' })
  expect(JSON.stringify(fixed.config)).not.toContain(OLD.serverScript)
})

test('a foreign server under our name is neither replaced nor removed', () => {
  const taken = { mcpServers: { [MCP_SERVER_NAME]: FOREIGN_CLAUDE } }
  expect(inspectMcpEntry(taken, 'claude-code', TARGET)).toBe('foreign')
  expect(() => mergeMcpEntry(taken, 'claude-code', TARGET)).toThrow('another server')
  expect(removeMcpEntry(taken, 'claude-code')).toEqual({ config: taken, removed: false })
})

test('remove takes out only ours; the section goes only when we emptied it', () => {
  for (const [host, config] of [['claude-code', claudeConfig()], ['opencode', openCodeConfig()]] as const) {
    const merged = mergeMcpEntry(config, host, TARGET).config
    expect(removeMcpEntry(merged, host)).toEqual({ config, removed: true })
  }
  const alone = mergeMcpEntry({ theme: 'x' }, 'opencode', TARGET).config
  expect(removeMcpEntry(alone, 'opencode')).toEqual({ config: { theme: 'x' }, removed: true })
  const untouched = claudeConfig()
  expect(removeMcpEntry(untouched, 'claude-code').config).toBe(untouched)
})

test('a malformed section is refused rather than overwritten', () => {
  expect(() => mergeMcpEntry({ mcpServers: [] }, 'claude-code', TARGET)).toThrow('fix it by hand')
  expect(() => removeMcpEntry({ mcp: 'x' }, 'opencode')).toThrow('fix it by hand')
})

test('an entry written before KINFOLD_MCP_HOST is ours but stale in both hosts, and a merge adds the host env', () => {
  const claudeOld = { mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', command: TARGET.bunPath, args: [TARGET.serverScript] } } }
  const openCodeOld = { mcp: { [MCP_SERVER_NAME]: { type: 'local', command: [TARGET.bunPath, TARGET.serverScript], enabled: true } } }
  expect(inspectMcpEntry(claudeOld, 'claude-code', TARGET)).toBe('stale')
  expect(inspectMcpEntry(openCodeOld, 'opencode', TARGET)).toBe('stale')
  const merged = mergeMcpEntry(openCodeOld, 'opencode', TARGET)
  expect(merged).toMatchObject({ changed: true, state: 'stale' })
  expect(merged.config).toEqual({ mcp: { [MCP_SERVER_NAME]: openCodeMcpEntry(TARGET) } })
})
