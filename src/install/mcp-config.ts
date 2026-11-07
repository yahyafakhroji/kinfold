// Our MCP server entry in Claude Code's and OpenCode's config, as pure
// functions over the parsed file (the caller reads and writes it, as with
// claude-hooks.ts). Claude Code keeps servers under `mcpServers` (user scope
// in ~/.claude.json, project scope in .mcp.json) as { type: 'stdio', command,
// args }. OpenCode 2.x keeps them under `mcp` in opencode.json as
// { type: 'local', command: [bin, ...args] }, the shape claude-mem's
// OpenCodeInstaller writes. The command comes from entry.ts: the checkout's
// bun on src/mcp/server.ts, or the installed program with --data-dir before
// `mcp`. An entry is ours when it runs one of those; an entry under our name
// that runs anything else is foreign and is never replaced or removed.

import { isRecord } from '../contract/event'
import { MCP_HOST_ENV } from '../mcp/read-reporter'
import { MCP_SERVER_NAME } from '../names'
import type { Settings } from './claude-hooks'
import { entryPath, entryRole, type EntryCommand } from './entry'

export { MCP_SERVER_NAME }

export interface McpTarget {
  /** The checkout's bun; used with serverScript when entry is absent. */
  bunPath?: string
  serverScript?: string
  /** The command an install writes, from entry.ts. */
  entry?: EntryCommand
}

function mcpEntry(target: McpTarget): EntryCommand {
  if (target.entry !== undefined) return target.entry
  if (target.bunPath === undefined || target.serverScript === undefined) throw new Error('an MCP target needs an entry or a checkout path')
  return { command: target.bunPath, args: [target.serverScript] }
}

export type McpHost = 'claude-code' | 'opencode'

/** yes: our entry with this target; stale: ours with another path; foreign: our name, someone else's server. */
export type McpEntryState = 'yes' | 'no' | 'stale' | 'foreign'

export interface McpMerge {
  config: Settings
  changed: boolean
  state: McpEntryState
}

export interface McpRemove {
  config: Settings
  removed: boolean
}

const SECTION: Readonly<Record<McpHost, string>> = { 'claude-code': 'mcpServers', opencode: 'mcp' }

/**
 * Each entry names its host in KINFOLD_MCP_HOST, so the server's read reports
 * say which host fetched. Claude Code calls the map `env`, OpenCode
 * `environment`. An entry written before this has no map, compares unequal,
 * reads as stale, and the next `kinfold install` replaces it.
 */
export function claudeMcpEntry(target: McpTarget): Record<string, unknown> {
  const entry = mcpEntry(target)
  return { type: 'stdio', command: entry.command, args: entry.args, env: { [MCP_HOST_ENV]: 'claude-code' } }
}

export function openCodeMcpEntry(target: McpTarget): Record<string, unknown> {
  const entry = mcpEntry(target)
  return { type: 'local', command: [entry.command, ...entry.args], enabled: true, environment: { [MCP_HOST_ENV]: 'opencode' } }
}

export function mcpEntryFor(host: McpHost, target: McpTarget): Record<string, unknown> {
  return host === 'claude-code' ? claudeMcpEntry(target) : openCodeMcpEntry(target)
}

/** [command, ...args] of an entry in either host's shape, or null. */
function argvOf(entry: unknown): readonly unknown[] | null {
  if (!isRecord(entry)) return null
  if (Array.isArray(entry.command)) return entry.command
  if (typeof entry.command !== 'string') return null
  return [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
}

/** The server.ts path or program path an entry runs, or null when it is not our MCP server. */
export function mcpServerScript(entry: unknown): string | null {
  const argv = argvOf(entry)
  if (argv === null) return null
  const words = argv.filter((arg): arg is string => typeof arg === 'string')
  if (words.length !== argv.length || words.length === 0) return null
  const [command, ...args] = words
  if (command === undefined) return null
  return entryRole(command, args) === 'mcp' ? entryPath(command, args) : null
}

function sectionOf(config: Settings, host: McpHost): Readonly<Record<string, unknown>> {
  const name = SECTION[host]
  const section = config[name]
  if (section === undefined) return {}
  if (!isRecord(section)) throw new Error(`"${name}" is not an object; fix it by hand first`)
  return section
}

export function inspectMcpEntry(config: Settings, host: McpHost, target: McpTarget): McpEntryState {
  const section = sectionOf(config, host)
  if (!Object.hasOwn(section, MCP_SERVER_NAME)) return 'no'
  const entry = section[MCP_SERVER_NAME]
  const script = mcpServerScript(entry)
  if (script === null) return 'foreign'
  return JSON.stringify(entry) === JSON.stringify(mcpEntryFor(host, target)) ? 'yes' : 'stale'
}

/**
 * Adds or refreshes our entry; every other server and key stays. A foreign
 * entry under our name throws, so the caller can tell the user instead of
 * overwriting it. An entry already equal to ours returns the same object.
 */
export function mergeMcpEntry(config: Settings, host: McpHost, target: McpTarget): McpMerge {
  const state = inspectMcpEntry(config, host, target)
  if (state === 'foreign') throw new Error(`${SECTION[host]}.${MCP_SERVER_NAME} is another server; rename or remove it by hand first`)
  if (state === 'yes') return { config, changed: false, state }
  const section = sectionOf(config, host)
  return { config: { ...config, [SECTION[host]]: { ...section, [MCP_SERVER_NAME]: mcpEntryFor(host, target) } }, changed: true, state }
}

/** True when `name` holds an entry that runs our server (any path); a foreign entry or none is false. */
export function hasOurMcpEntryNamed(config: Settings, host: McpHost, name: string): boolean {
  const section = sectionOf(config, host)
  return Object.hasOwn(section, name) && mcpServerScript(section[name]) !== null
}

/** Removes only our entry under `name`; the section goes only when that emptied it. A foreign entry stays. */
export function removeMcpEntryNamed(config: Settings, host: McpHost, name: string): McpRemove {
  if (!hasOurMcpEntryNamed(config, host, name)) return { config, removed: false }
  const { [name]: _ours, ...others } = sectionOf(config, host)
  const sectionName = SECTION[host]
  if (Object.keys(others).length > 0) return { config: { ...config, [sectionName]: others }, removed: true }
  const { [sectionName]: _section, ...rest } = config
  return { config: rest, removed: true }
}

/** Removes only our entry; the section goes only when that emptied it. A foreign entry stays. */
export function removeMcpEntry(config: Settings, host: McpHost): McpRemove {
  return removeMcpEntryNamed(config, host, MCP_SERVER_NAME)
}
