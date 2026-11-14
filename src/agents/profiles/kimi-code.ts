// Kimi Code CLI: [[hooks]] tables in ~/.kimi-code/config.toml and the MCP
// server in ~/.kimi-code/mcp.json. Built from the Kimi Code docs, checked
// 2026-11-13:
//   kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html ([[hooks]]
//     with event, matcher, command, timeout (s) and nothing else; user-level
//     config.toml only; UserPromptSubmit "returned text is appended to
//     context"; SessionStart and the other non-blocking events are
//     observation-only, so what they print is dropped)
//   kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html (user-level
//     ~/.kimi-code/mcp.json or $KIMI_CODE_HOME/mcp.json, mcpServers with
//     command, args, env)
//   kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html
//     (KIMI_CODE_HOME moves the whole data root, config.toml included)
//   kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html
//     (C:\Users\<name>\.kimi-code on Windows)
// The parser is src/adapters/kimi-code.ts. The hooks page shows only the
// shared stdin fields, so the prompt and tool-output field names are read the
// Claude Code way and the limit says so. KIMI_CODE_HOME is held to Codex's
// CODEX_HOME rule (an existing folder). The docs don't name the shell a hook
// command runs in on Windows; until the single-quoted command is checked
// there, Windows gets the MCP server only. The binary is `kimi`.

import { join } from 'node:path'
import { KIMI_CODE_EVENTS } from '../../adapters/kimi-code'
import { resolveAgentHome } from '../../install/codex-home'
import { type InstallEnv, platformOf } from '../../install/env'
import type { Action } from '../../install/plan'
import type { OsName } from '../../platform/platform'
import { type AgentHome, type JsonAgentFile, jsonAgentFileInstallActions, jsonAgentFileUninstallActions, mcpServersFile } from '../families/json-agent'
import { mcpEntryState } from '../families/mcp-entry'
import { tomlHooksActions, tomlHooksState, tomlHooksUninstallActions } from '../families/toml-file'
import type { AgentProfile, Capabilities } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: false, prompt: true }, search: true, observer: false }
const WINDOWS_CAPABILITIES: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false }

const LIMIT = 'Kimi drops what SessionStart prints, so context arrives with each prompt; the hooks page names no prompt or tool-output fields, so those are read the Claude Code way'
const WINDOWS_LIMIT = 'no hooks on Windows: the shell Kimi Code runs hook commands through is not documented, and the hook command is not yet checked against it'

const HOST = 'kimi-code'

const onWindows = (os: OsName): boolean => os === 'windows'
const windowsEnv = (env: InstallEnv): boolean => onWindows(platformOf(env).os)

export const KIMI_CODE_HOME: AgentHome = {
  variable: 'KIMI_CODE_HOME',
  resolve: (env) => resolveAgentHome('KIMI_CODE_HOME', env.kimiCodeHomeEnv, join(env.homeDir, '.kimi-code'), env.cwd),
  unset: (env) => ({ ...env, kimiCodeHomeEnv: undefined }),
}

/** An unusable KIMI_CODE_HOME reads as the default; install skips Kimi and status says why. */
function kimiDir(env: InstallEnv): string {
  const home = KIMI_CODE_HOME.resolve(env)
  return home.ok ? home.dir : join(env.homeDir, '.kimi-code')
}

export const kimiConfigPath = (env: InstallEnv): string => join(kimiDir(env), 'config.toml')

export const KIMI_MCP_FILE: JsonAgentFile = mcpServersFile((env) => join(kimiDir(env), 'mcp.json'))

/** `alongside` is what the line says Kimi still gets when config.toml is refused. */
export function kimiHooksActions(env: InstallEnv, alongside?: string): Action[] {
  return tomlHooksActions(env, kimiConfigPath(env), KIMI_CODE_EVENTS, HOST, alongside)
}

export function kimiHooksUninstallActions(env: InstallEnv): Action[] {
  return tomlHooksUninstallActions(env, kimiConfigPath(env), HOST)
}

function problemOf(env: InstallEnv): string | null {
  const home = KIMI_CODE_HOME.resolve(env)
  return home.ok ? null : home.reason
}

function install(env: InstallEnv): Action[] {
  const home = KIMI_CODE_HOME.resolve(env)
  if (!home.ok) {
    env.out(`${HOST}: ${home.reason}; nothing was wired. Fix or unset KIMI_CODE_HOME and rerun`)
    return []
  }
  if (home.fromEnv) env.out(`${HOST}: KIMI_CODE_HOME is set; using ${home.dir}`)
  const mcp = jsonAgentFileInstallActions(env, HOST, KIMI_MCP_FILE)
  // The MCP entry lives in its own file, so a refused config.toml leaves search wired.
  const hooks = windowsEnv(env) ? [] : kimiHooksActions(env, mcp.length > 0 ? 'MCP written' : 'MCP left as it is')
  return [...hooks, ...mcp]
}

/** Ours out of the folder the variable points at and, when that differs, out of the default one too. */
function uninstall(env: InstallEnv): Action[] {
  const seen = new Set<string>()
  return [env, KIMI_CODE_HOME.unset(env)].flatMap((each) => {
    const dir = kimiDir(each)
    if (seen.has(dir)) return []
    seen.add(dir)
    return [...kimiHooksUninstallActions(each), ...jsonAgentFileUninstallActions(each, HOST, KIMI_MCP_FILE)]
  })
}

function mcpState(env: InstallEnv): string {
  return KIMI_MCP_FILE.mcp === undefined ? 'no' : mcpEntryState(env, KIMI_MCP_FILE.mcp, HOST)
}

export const KIMI_CODE_PROFILE: AgentProfile = {
  id: HOST,
  name: 'Kimi Code',
  family: 'claude-style',
  verification: 'docs',
  capabilities: (os) => (onWindows(os) ? WINDOWS_CAPABILITIES : CAPABILITIES),
  limit: (os) => (onWindows(os) ? WINDOWS_LIMIT : LIMIT),
  detection: { binaries: ['kimi'] },
  wiring: {
    install: async (env) => install(env),
    uninstall,
    state: (env) => {
      if (problemOf(env) !== null) return 'unknown'
      if (!windowsEnv(env)) return tomlHooksState(env, kimiConfigPath(env), KIMI_CODE_EVENTS, HOST)
      const mcp = mcpState(env)
      return mcp === 'yes' || mcp === 'stale' || mcp === 'unknown' ? mcp : 'no'
    },
    line: (env) => {
      const problem = problemOf(env)
      if (problem !== null) return `unknown (${problem}) in ${kimiConfigPath(env)}`
      const mcp = `MCP ${mcpState(env)} in ${KIMI_MCP_FILE.path(env)}`
      return windowsEnv(env) ? mcp : `hooks ${tomlHooksState(env, kimiConfigPath(env), KIMI_CODE_EVENTS, HOST)} in ${kimiConfigPath(env)}; ${mcp}`
    },
  },
  manualSteps: () => [],
}
