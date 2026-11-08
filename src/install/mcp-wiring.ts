// Registers the MCP read server (src/mcp/server.ts) with each host. Claude
// Code keeps user-scope servers in ~/.claude.json, a large file it rewrites
// itself while running, so we read it only to inspect our entry and change it
// through `claude mcp add-json|remove --scope user`, never by writing the file.
// OpenCode reads opencode.json once per start, so we merge our `mcp` entry
// into it with a backup, as claude-hooks.ts does for settings.json.

import { join } from 'node:path'
import { isRecord } from '../contract/event'
import type { InstallEnv } from './env'
import { entryCommand, entryIdentity } from './entry'
import { plannedBackup, readJsonObject, serializeJson } from './files'
import { LEGACY_MCP_SERVER_NAME } from '../names'
import { MCP_HOST_ENV } from '../mcp/read-reporter'
import { MCP_SERVER_NAME, type McpEntryState, type McpTarget, claudeMcpEntry, hasOurMcpEntryNamed, inspectMcpEntry, mergeMcpEntry, removeMcpEntry, removeMcpEntryNamed } from './mcp-config'
import type { Action } from './plan'

/** Same modes install.ts gives the files it creates in a host's config dir. */
const DIR_MODE = 0o755
const FILE_MODE = 0o644

export interface McpPaths {
  claudeUserConfig: string
  opencodeConfig: string
  opencodeDir: string
}

export function mcpPaths(env: Pick<InstallEnv, 'homeDir'>): McpPaths {
  const opencodeDir = join(env.homeDir, '.config', 'opencode')
  return { claudeUserConfig: join(env.homeDir, '.claude.json'), opencodeConfig: join(opencodeDir, 'opencode.json'), opencodeDir }
}

export function mcpTarget(env: Pick<InstallEnv, 'mode' | 'dataDir'>): McpTarget {
  const entry = entryCommand(env.mode, 'mcp', env.dataDir)
  return { entry }
}

export const claudeAddArgv = (entry: Record<string, unknown>): string[] => ['claude', 'mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, JSON.stringify(entry)]
export const CLAUDE_MCP_REMOVE_ARGV: readonly string[] = ['claude', 'mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]

const claudeAdd = (target: McpTarget): Action => ({
  kind: 'command',
  argv: claudeAddArgv(claudeMcpEntry(target)),
  summary: 'register the Kinfold MCP server with Claude Code (user scope)',
})

/**
 * The swap replays the previous entry through argv, which any process can read
 * and which the plan prints. That is safe only for an entry whose env holds
 * nothing but the host name Kinfold wrote itself.
 */
export function rollbackSafe(previous: Record<string, unknown>): boolean {
  const env = previous.env
  if (env === undefined) return true
  return isRecord(env) && Object.keys(env).every((key) => key === MCP_HOST_ENV)
}

/** Our own entry as ~/.claude.json holds it now, or null when it cannot be read back. */
function previousClaudeEntry(path: string): Record<string, unknown> | null {
  try {
    const file = readJsonObject(path)
    const section = file.exists ? file.value.mcpServers : undefined
    const entry = isRecord(section) ? section[MCP_SERVER_NAME] : undefined
    return isRecord(entry) ? entry : null
  } catch {
    return null
  }
}

const claudeRemove: Action = {
  kind: 'command',
  argv: CLAUDE_MCP_REMOVE_ARGV,
  summary: 'unregister the Kinfold MCP server from Claude Code',
}

function stateIn(path: string, host: 'claude-code' | 'opencode', target: McpTarget): McpEntryState | 'unknown' {
  try {
    const file = readJsonObject(path)
    return file.exists ? inspectMcpEntry(file.value, host, target) : 'no'
  } catch {
    // A file that does not parse is reported and left alone, never rewritten.
    return 'unknown'
  }
}

export function claudeMcpState(env: InstallEnv): McpEntryState | 'unknown' {
  return stateIn(mcpPaths(env).claudeUserConfig, 'claude-code', mcpTarget(env))
}

export function opencodeMcpState(env: InstallEnv): McpEntryState | 'unknown' {
  return stateIn(mcpPaths(env).opencodeConfig, 'opencode', mcpTarget(env))
}

export function claudeMcpInstallActions(env: InstallEnv): Action[] {
  const state = claudeMcpState(env)
  const where = mcpPaths(env).claudeUserConfig
  if (state === 'yes') {
    env.out(`claude-code: MCP server already registered in ${where}`)
    return []
  }
  if (state === 'foreign' || state === 'unknown') {
    const why = state === 'foreign' ? `a server named ${MCP_SERVER_NAME} that is not ours is registered` : `${where} could not be read`
    env.out(`claude-code: MCP server not registered (${why}); left alone`)
    return []
  }
  if (state !== 'stale') return [claudeAdd(mcpTarget(env))]
  // The CLI has no overwrite for an existing name, so the swap is one step that puts the old entry back if the add fails.
  const previous = previousClaudeEntry(where)
  if (previous === null) {
    env.out(`claude-code: MCP server entry in ${where} could not be read back; left alone`)
    return []
  }
  if (!rollbackSafe(previous)) {
    env.out(`claude-code: MCP server entry in ${where} is stale but carries env values Kinfold did not write; left alone, since replacing it would pass them on a command line. Remove it with claude mcp remove --scope user ${MCP_SERVER_NAME} and rerun`)
    return []
  }
  return [{ kind: 'claude-mcp-replace', previous, next: claudeMcpEntry(mcpTarget(env)) }]
}

/**
 * Our `mcp` entry in opencode.json, in one write that also drops our entry
 * under the pre-rename name, so the file never lacks a memory server and is
 * never written twice by one plan. A foreign kinfold entry leaves the old one too.
 */
export function opencodeMcpInstallActions(env: InstallEnv): Action[] {
  const paths = mcpPaths(env)
  const file = readJsonObject(paths.opencodeConfig)
  const config = file.exists ? file.value : {}
  const state = file.exists ? inspectMcpEntry(config, 'opencode', mcpTarget(env)) : 'no'
  const legacy = hasOurMcpEntryNamed(config, 'opencode', LEGACY_MCP_SERVER_NAME)
  if (state === 'yes' && !legacy) {
    env.out(`opencode: MCP server already in ${paths.opencodeConfig}`)
    return []
  }
  if (state === 'foreign') {
    env.out(`opencode: an MCP server named ${MCP_SERVER_NAME} that is not ours is in ${paths.opencodeConfig}; left alone`)
    return []
  }
  const merged = mergeMcpEntry(legacy ? removeMcpEntryNamed(config, 'opencode', LEGACY_MCP_SERVER_NAME).config : config, 'opencode', mcpTarget(env))
  const backup = file.exists ? plannedBackup(paths.opencodeConfig, env.now()) : null
  const parts = [
    state === 'yes' ? '' : `${state === 'stale' ? 'replace the stale' : 'add the'} Kinfold MCP server under "mcp"`,
    legacy ? `remove the one under its old name ${LEGACY_MCP_SERVER_NAME}` : '',
    'every other key kept',
  ].filter((part) => part !== '')
  return [
    ...(file.exists ? [] : [{ kind: 'mkdir', path: paths.opencodeDir, mode: DIR_MODE } as const]),
    ...(backup !== null ? [{ kind: 'backup', from: paths.opencodeConfig, to: backup } as const] : []),
    {
      kind: 'write',
      path: paths.opencodeConfig,
      content: serializeJson(merged.config, file.exists ? file.text : null),
      mode: file.exists ? file.mode : FILE_MODE,
      summary: parts.join('; '),
    },
  ]
}

export function claudeMcpUninstallActions(env: InstallEnv): Action[] {
  const state = claudeMcpState(env)
  return state === 'yes' || state === 'stale' ? [claudeRemove] : []
}

export function opencodeMcpUninstallActions(env: InstallEnv): Action[] {
  const path = mcpPaths(env).opencodeConfig
  const file = readJsonObject(path)
  if (!file.exists) return []
  const state = inspectMcpEntry(file.value, 'opencode', mcpTarget(env))
  if (state !== 'yes' && state !== 'stale') return []
  const removed = removeMcpEntry(file.value, 'opencode')
  const backup = plannedBackup(path, env.now())
  return [
    ...(backup !== null ? [{ kind: 'backup', from: path, to: backup } as const] : []),
    { kind: 'write', path, content: serializeJson(removed.config, file.text), mode: file.mode, summary: 'remove the Kinfold MCP server; every other key kept' },
  ]
}

export function mcpStatusLines(env: InstallEnv): string[] {
  const paths = mcpPaths(env)
  return [
    `mcp server ${entryIdentity(env.mode, 'mcp', env.dataDir)}:`,
    `  claude-code: ${claudeMcpState(env)} in ${paths.claudeUserConfig}`,
    `  opencode: ${opencodeMcpState(env)} in ${paths.opencodeConfig}`,
  ]
}
