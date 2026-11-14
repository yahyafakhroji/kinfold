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
// On Windows the command is written for cmd (hook-shell.ts): the hooks page,
// checked 2026-11-14, says of `command`, "Executed via `sh -c` on macOS/Linux
// and `cmd /c` on Windows."

import { join } from 'node:path'
import { resolveAgentHome } from '../../install/codex-home'
import type { InstallEnv } from '../../install/env'
import { AGENT_HOOK_TIMEOUT_S, type AgentHome, type JsonAgentFile, jsonAgentWiring, mcpServersFile } from '../families/json-agent'
import type { AgentProfile, Capabilities } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: false, prompt: true }, search: true, observer: false }

const LIMIT = 'Junie documents a session id only on session start and prompts; events without one are not recorded'

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

export const JUNIE_FILES: readonly JsonAgentFile[] = [
  {
    path: (env) => join(junieDir(env), 'config.json'),
    hooks: {
      shape: 'command',
      grouped: true,
      host: 'junie',
      label: 'Junie config.json',
      events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'],
      hooksKey: 'hooks',
      timeoutS: AGENT_HOOK_TIMEOUT_S,
      windowsShell: 'cmd',
    },
  },
  mcpServersFile((env) => join(junieDir(env), 'mcp', 'mcp.json')),
]

export const JUNIE_PROFILE: AgentProfile = {
  id: 'junie',
  name: 'Junie',
  family: 'claude-style',
  verification: 'docs',
  capabilities: () => CAPABILITIES,
  limit: () => LIMIT,
  shortLimit: () => 'Events without a session id are not recorded; the docs show one only on session start and prompts.',
  detection: { binaries: ['junie'] },
  wiring: jsonAgentWiring('junie', JUNIE_FILES, JUNIE_HOME),
  manualSteps: () => [],
}
