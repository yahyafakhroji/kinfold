// The wiring of an agent configured through plain JSON files: per file, our
// hook entries (or a hook definition under our name, for Antigravity), our
// MCP entry, or both. Both in one file go through one
// json-file.ts plan, one read and one write, so neither edit loses the other.
// An agent whose home a variable moves (COPILOT_HOME, JUNIE_HOME,
// GEMINI_CLI_HOME) is resolved
// the way Codex's is: an unusable value skips the agent with the reason.

import type { CodexHome } from '../../install/codex-home'
import type { InstallEnv } from '../../install/env'
import { MCP_SERVER_NAME, type McpEntryState } from '../../install/mcp-config'
import { mcpTarget } from '../../install/mcp-wiring'
import type { Action } from '../../install/plan'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import type { AgentId, AgentWiring } from '../profile'
import { type HookDefinitionSpec, hookDefinitionEdit, hookDefinitionRemoveEdit, hookDefinitionState } from './hook-definition'
import { type JsonEdit, plainJsonFileActions, plainJsonFileUninstallActions } from './json-file'
import { type JsonHooksSpec, type WiringState, hookTarget, jsonHooksEdit, jsonHooksRemoveEdit, jsonHooksState } from './json-hooks'
import { type McpEntrySpec, mcpEntryEdit, mcpEntryRemoveEdit, mcpEntryState } from './mcp-entry'

/** Seconds an agent waits for our hook; the same as Claude Code's and Codex's entries. */
export const AGENT_HOOK_TIMEOUT_S = 10

export interface JsonAgentFile {
  path(env: InstallEnv): string
  hooks?: JsonHooksSpec
  /** Our hooks as one definition under our hook name, instead of entries under each event. */
  definition?: HookDefinitionSpec
  /** Its path() names the same file. */
  mcp?: McpEntrySpec
  /** A file only Kinfold writes: uninstall deletes it once nothing but these keys is left. */
  removeWhenOnly?: readonly string[]
  /** Whether an install writes this file here; uninstall always clears ours out of it. Default yes. */
  when?: (env: InstallEnv) => boolean
}

export interface AgentHome {
  /** The variable that moves the home, for messages. */
  variable: string
  resolve(env: InstallEnv): CodexHome
  /** The same env with the variable unset: where an install without it wrote. */
  unset(env: InstallEnv): InstallEnv
}

/** The files an install writes on this env. */
const activeFiles = (env: InstallEnv, files: readonly JsonAgentFile[]): readonly JsonAgentFile[] => files.filter((file) => file.when?.(env) ?? true)

const problemOf = (env: InstallEnv, home: AgentHome | undefined): string | null => {
  if (home === undefined) return null
  const resolved = home.resolve(env)
  return resolved.ok ? null : resolved.reason
}

export function jsonAgentFileInstallActions(env: InstallEnv, host: AgentId, file: JsonAgentFile): Action[] {
  const edits: JsonEdit[] = [
    ...(file.hooks !== undefined ? [jsonHooksEdit(file.hooks, hookTarget(env, host), host)] : []),
    ...(file.definition !== undefined ? [hookDefinitionEdit(file.definition, hookTarget(env, host))] : []),
    ...(file.mcp !== undefined ? [mcpEntryEdit(file.mcp, mcpTarget(env), host)] : []),
  ]
  return plainJsonFileActions(env, file.path(env), edits, host)
}

/** Our MCP entry as usual, and our hooks out of the file. */
function jsonAgentFileSearchOnlyActions(env: InstallEnv, host: AgentId, file: JsonAgentFile): Action[] {
  const edits: JsonEdit[] = [
    ...(file.hooks !== undefined ? [jsonHooksRemoveEdit(file.hooks)] : []),
    ...(file.definition !== undefined ? [hookDefinitionRemoveEdit(file.definition)] : []),
    ...(file.mcp !== undefined ? [mcpEntryEdit(file.mcp, mcpTarget(env), host)] : []),
  ]
  return plainJsonFileActions(env, file.path(env), edits, host)
}

export function jsonAgentFileUninstallActions(env: InstallEnv, host: AgentId, file: JsonAgentFile): Action[] {
  const edits: JsonEdit[] = [
    ...(file.hooks !== undefined ? [jsonHooksRemoveEdit(file.hooks)] : []),
    ...(file.definition !== undefined ? [hookDefinitionRemoveEdit(file.definition)] : []),
    ...(file.mcp !== undefined ? [mcpEntryRemoveEdit(file.mcp)] : []),
  ]
  return plainJsonFileUninstallActions(env, file.path(env), edits, host, file.removeWhenOnly)
}

/** An MCP entry under our name that is not ours is not our wiring. */
function fromMcp(state: McpEntryState | 'unknown'): WiringState | 'unknown' {
  return state === 'foreign' ? 'no' : state
}

/** The state of a file's hooks, in either form; null when the file holds none. */
function hooksState(env: InstallEnv, host: AgentId, file: JsonAgentFile): WiringState | 'unknown' | null {
  if (file.hooks !== undefined) return jsonHooksState(env, file.path(env), file.hooks, host)
  if (file.definition !== undefined) return hookDefinitionState(env, file.path(env), file.definition)
  return null
}

/** The hooks decide the state when the agent has any; an agent wired for search only goes by its MCP entry. */
function wiringState(env: InstallEnv, host: AgentId, files: readonly JsonAgentFile[]): WiringState | 'unknown' {
  for (const file of files) {
    const state = hooksState(env, host, file)
    if (state !== null) return state
  }
  const served = files.find((file) => file.mcp !== undefined)
  return served?.mcp !== undefined ? fromMcp(mcpEntryState(env, served.mcp, host)) : 'no'
}

function fileLine(env: InstallEnv, host: AgentId, file: JsonAgentFile): string {
  const hooks = hooksState(env, host, file)
  const parts = [
    ...(hooks !== null ? [`hooks ${hooks}`] : []),
    ...(file.mcp !== undefined ? [`MCP ${mcpEntryState(env, file.mcp, host)}`] : []),
  ]
  return `${parts.join(', ')} in ${file.path(env)}`
}

type FilePlanner = (env: InstallEnv, host: AgentId, file: JsonAgentFile) => Action[]

function installActions(env: InstallEnv, host: AgentId, files: readonly JsonAgentFile[], home: AgentHome | undefined, plan: FilePlanner = jsonAgentFileInstallActions): Action[] {
  const resolved = home?.resolve(env)
  if (home !== undefined && resolved !== undefined && !resolved.ok) {
    env.out(`${host}: ${resolved.reason}; nothing was wired. Fix or unset ${home.variable} and rerun`)
    return []
  }
  if (home !== undefined && resolved?.ok === true && resolved.fromEnv) env.out(`${host}: ${home.variable} is set; using ${resolved.dir}`)
  return activeFiles(env, files).flatMap((file) => plan(env, host, file))
}

/** The files with no hooks of ours, so the state goes by the MCP entry. */
const withoutHookSpecs = (files: readonly JsonAgentFile[]): readonly JsonAgentFile[] => files.map(({ hooks: _hooks, definition: _definition, ...rest }) => rest)

/** Ours out of the files the variable points at and, when those differ, out of the default ones too. */
function uninstallActions(env: InstallEnv, host: AgentId, files: readonly JsonAgentFile[], home: AgentHome | undefined): Action[] {
  const envs = home === undefined ? [env] : [env, home.unset(env)]
  const seen = new Set<string>()
  return envs.flatMap((each) =>
    files.flatMap((file) => {
      const path = file.path(each)
      if (seen.has(path)) return []
      seen.add(path)
      return jsonAgentFileUninstallActions(each, host, file)
    }),
  )
}

export function jsonAgentWiring(host: AgentId, files: readonly JsonAgentFile[], home?: AgentHome): AgentWiring {
  const wiring: AgentWiring = {
    install: async (env) => installActions(env, host, files, home),
    uninstall: (env) => uninstallActions(env, host, files, home),
    state: (env) => (problemOf(env, home) !== null ? 'unknown' : wiringState(env, host, activeFiles(env, files))),
    line: (env) => {
      const problem = problemOf(env, home)
      const active = activeFiles(env, files)
      const paths = active.map((file) => file.path(env)).join(', ')
      return problem !== null ? `unknown (${problem}) in ${paths}` : active.map((file) => fileLine(env, host, file)).join('; ')
    },
  }
  return {
    ...wiring,
    withoutHooks: () => ({
      ...wiring,
      install: async (env) => installActions(env, host, files, home, jsonAgentFileSearchOnlyActions),
      state: (env) => (problemOf(env, home) !== null ? 'unknown' : wiringState(env, host, withoutHookSpecs(activeFiles(env, files)))),
    }),
  }
}

/** Our MCP entry as most agents read it: command, args and the env var that names the agent. */
export function stdioMcpEntry(extra: Readonly<Record<string, unknown>> = {}): McpEntrySpec['entry'] {
  return (target, host) => ({ ...extra, command: target.entry.command, args: target.entry.args, env: { [MCP_HOST_ENV]: host } })
}

/** Our MCP entry as `"kinfold": {...}`, exactly as install would write it, for a step the user does by hand. */
export function mcpEntryText(spec: McpEntrySpec, env: InstallEnv, host: AgentId): string {
  return `"${MCP_SERVER_NAME}": ${JSON.stringify(spec.entry(mcpTarget(env), host))}`
}

/** A file holding only our MCP entry, under mcpServers. */
export function mcpServersFile(path: (env: InstallEnv) => string, extra: Readonly<Record<string, unknown>> = {}): JsonAgentFile {
  return { path, mcp: { path, key: 'mcpServers', entry: stdioMcpEntry(extra) } }
}
