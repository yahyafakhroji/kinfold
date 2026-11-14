// JetBrains Junie CLI: Claude-style command hooks in ~/.junie/config.json and
// the MCP server in ~/.junie/mcp/mcp.json. Built from the Junie docs, checked
// 2026-11-13:
//   junie.jetbrains.com/docs/junie-cli-hooks.html (events, the stdin examples
//     copied into test/fixtures/junie/, timeouts in seconds, `sh -c` /
//     `cmd /c`, project config ignored by default, SessionStart ignores
//     additionalContext, UserPromptSubmit prepends it)
//   junie.jetbrains.com/docs/junie-cli-mcp-configuration.html (user scope
//     ~/.junie/mcp/mcp.json, mcpServers with command, args and env)
//   junie.jetbrains.com/docs/junie-cli.html (the `junie` command)
// The docs' examples carry session_id and cwd only on SessionStart and
// UserPromptSubmit; an event without them is not captured, which the
// capability line says.
//   junie.jetbrains.com/docs/environment-variables.html (JUNIE_HOME overrides
//     the default ~/.junie; whether it must exist is not said, so it is held
//     to Codex's CODEX_HOME rule)
// On Windows Junie runs a hook through `cmd /c`, where the single-quoted
// command an install writes does not quote; until that is checked against a
// real run, Windows gets no hooks and search only.

import { join } from 'node:path'
import { resolveAgentHome } from '../../install/codex-home'
import { type InstallEnv, platformOf } from '../../install/env'
import type { OsName } from '../../platform/platform'
import { AGENT_HOOK_TIMEOUT_S, type AgentHome, type JsonAgentFile, jsonAgentWiring, mcpServersFile } from '../families/json-agent'
import type { AgentProfile, Capabilities } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: false, prompt: true }, search: true, observer: false }
const WINDOWS_CAPABILITIES: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false }

const LIMIT = 'Junie documents a session id only on session start and prompts; events without one are not recorded'
const WINDOWS_LIMIT = 'no hooks on Windows: Junie runs them through cmd /c, which the hook command is not yet checked against'

export const JUNIE_HOME: AgentHome = {
  variable: 'JUNIE_HOME',
  resolve: (env) => resolveAgentHome('JUNIE_HOME', env.junieHomeEnv, join(env.homeDir, '.junie'), env.cwd),
  unset: (env) => ({ ...env, junieHomeEnv: undefined }),
}

/** An unusable JUNIE_HOME reads as the default; install skips Junie and status says why. */
function junieDir(env: InstallEnv): string {
  const home = JUNIE_HOME.resolve(env)
  return home.ok ? home.dir : join(env.homeDir, '.junie')
}

const onWindows = (os: OsName): boolean => os === 'windows'

export const JUNIE_FILES: readonly JsonAgentFile[] = [
  {
    path: (env) => join(junieDir(env), 'config.json'),
    when: (env) => !onWindows(platformOf(env).os),
    hooks: {
      shape: 'command',
      grouped: true,
      host: 'junie',
      label: 'Junie config.json',
      events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'],
      hooksKey: 'hooks',
      timeoutS: AGENT_HOOK_TIMEOUT_S,
    },
  },
  mcpServersFile((env) => join(junieDir(env), 'mcp', 'mcp.json')),
]

export const JUNIE_PROFILE: AgentProfile = {
  id: 'junie',
  name: 'Junie',
  family: 'claude-style',
  verification: 'docs',
  capabilities: (os) => (onWindows(os) ? WINDOWS_CAPABILITIES : CAPABILITIES),
  limit: (os) => (onWindows(os) ? WINDOWS_LIMIT : LIMIT),
  detection: { binaries: ['junie'] },
  wiring: jsonAgentWiring('junie', JUNIE_FILES, JUNIE_HOME),
  manualSteps: () => [],
}
