// Kinfold's MCP read server in an agent's JSON config, under the key that
// agent reads servers from. Plan actions in the form mcp-wiring.ts uses for
// opencode.json: read the file (one that is not plain JSON is refused,
// untouched), merge our entry under our server name, back the original up
// before the first change, write it atomically. An entry is ours when it runs
// our MCP server (mcp-config.ts); one under our name that runs anything else
// is someone else's and is never replaced or removed.
// The edits are exported too, so an agent whose hooks and MCP server share one
// file plans both through one json-file.ts call: one read, one write.

import { isRecord } from '../../contract/event'
import type { InstallEnv } from '../../install/env'
import { MCP_SERVER_NAME, type McpEntryState, type McpTarget, mcpServerScript } from '../../install/mcp-config'
import { mcpTarget } from '../../install/mcp-wiring'
import type { Action } from '../../install/plan'
import type { AgentId } from '../profile'
import { type JsonEdit, type Settings, plainJsonFileActions, plainJsonFileUninstallActions } from './json-file'
import { readPlainJsonObject } from './plain-json'

export interface McpEntrySpec {
  path(env: InstallEnv): string
  key: 'mcpServers' | 'context_servers' | 'mcp' | 'amp.mcpServers'
  entry(target: McpTarget, host: AgentId): Record<string, unknown>
}

function sectionOf(spec: McpEntrySpec, config: Settings): Readonly<Record<string, unknown>> {
  const section = config[spec.key]
  if (section === undefined) return {}
  if (!isRecord(section)) throw new Error(`"${spec.key}" is not an object; fix it by hand first`)
  return section
}

function inspect(spec: McpEntrySpec, config: Settings, expected: Record<string, unknown>): McpEntryState {
  const section = sectionOf(spec, config)
  if (!Object.hasOwn(section, MCP_SERVER_NAME)) return 'no'
  const entry = section[MCP_SERVER_NAME]
  if (mcpServerScript(entry) === null) return 'foreign'
  return JSON.stringify(entry) === JSON.stringify(expected) ? 'yes' : 'stale'
}

/** Our entry out; the section goes only when that emptied it. */
function withoutOurs(spec: McpEntrySpec, config: Settings): Settings {
  const { [MCP_SERVER_NAME]: _ours, ...others } = sectionOf(spec, config)
  if (Object.keys(others).length > 0) return { ...config, [spec.key]: others }
  const { [spec.key]: _section, ...rest } = config
  return rest
}

/** Our entry added or refreshed; one under our name that is not ours is left alone. */
export function mcpEntryEdit(spec: McpEntrySpec, target: McpTarget, host: AgentId): JsonEdit {
  return (config, path) => {
    const expected = spec.entry(target, host)
    const state = inspect(spec, config, expected)
    if (state === 'yes') return { settings: config, changed: false, note: `MCP server already in ${path}` }
    if (state === 'foreign') return { settings: config, changed: false, note: `an MCP server named ${MCP_SERVER_NAME} that is not ours is in ${path}; left alone` }
    return {
      settings: { ...config, [spec.key]: { ...sectionOf(spec, config), [MCP_SERVER_NAME]: expected } },
      changed: true,
      summary: `${state === 'stale' ? 'replace the stale' : 'add the'} Kinfold MCP server under "${spec.key}"`,
    }
  }
}

/** Only our entry out; a foreign one under our name stays. */
export function mcpEntryRemoveEdit(spec: McpEntrySpec): JsonEdit {
  return (config) => {
    const section = sectionOf(spec, config)
    if (!Object.hasOwn(section, MCP_SERVER_NAME) || mcpServerScript(section[MCP_SERVER_NAME]) === null) return { settings: config, changed: false }
    return { settings: withoutOurs(spec, config), changed: true, summary: 'remove the Kinfold MCP server' }
  }
}

export function mcpEntryActions(env: InstallEnv, spec: McpEntrySpec, host: AgentId): Action[] {
  return plainJsonFileActions(env, spec.path(env), [mcpEntryEdit(spec, mcpTarget(env), host)], host)
}

export function mcpEntryUninstallActions(env: InstallEnv, spec: McpEntrySpec): Action[] {
  const path = spec.path(env)
  return plainJsonFileUninstallActions(env, path, [mcpEntryRemoveEdit(spec)], path)
}

/** The entry's state alone, read-only; 'unknown' when the file can't be read. `host` picks the entry an install would write. */
export function mcpEntryState(env: InstallEnv, spec: McpEntrySpec, host: AgentId): McpEntryState | 'unknown' {
  try {
    const file = readPlainJsonObject(spec.path(env))
    return file.exists ? inspect(spec, file.value, spec.entry(mcpTarget(env), host)) : 'no'
  } catch {
    return 'unknown'
  }
}
