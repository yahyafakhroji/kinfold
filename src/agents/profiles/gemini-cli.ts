// Gemini CLI: command hooks and the MCP server, both in ~/.gemini/settings.json,
// so one plan writes them. Built from the Gemini CLI docs, checked 2026-11-13:
//   geminicli.com/docs/hooks/reference (events, the common stdin fields,
//     hookSpecificOutput.additionalContext on SessionStart, BeforeAgent and
//     AfterTool, `type`/`command`/`timeout` in milliseconds, no args)
//   geminicli.com/docs/hooks/ (hooks run from settings.json; no stdin example)
//   geminicli.com/docs/reference/configuration/ (~/.gemini/settings.json,
//     hooksConfig.enabled defaulting to true, mcpServers with command, args and
//     env, and GEMINI_CLI_HOME, the root that holds the .gemini folder)
// The docs banner says Antigravity CLI replaced Gemini CLI for unpaid and
// Google One users on 2026-06-18; Gemini CLI still ships for paid users, so it
// keeps its own profile. The pages show no stdin payloads, so
// test/fixtures/gemini-cli/ holds docs-constructed-*.json built from the
// documented fields.
// GEMINI_CLI_HOME names the folder that holds .gemini, not .gemini itself.
// Whether it must exist is not said, so it is held to Codex's CODEX_HOME rule.
// The docs don't say which shell runs a hook; the source does, checked
// 2026-11-14. hookRunner.ts spawns getShellConfiguration()'s shell with the
// command as its last argument, and on Windows that is pwsh.exe, or
// powershell.exe when pwsh is not installed, with -NoProfile -NonInteractive
// -Command:
//   github.com/google-gemini/gemini-cli/blob/main/packages/core/src/hooks/hookRunner.ts
//   github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/shell-utils.ts
// So on Windows the command is written for PowerShell (hook-shell.ts).

import { join } from 'node:path'
import { resolveAgentHome } from '../../install/codex-home'
import type { InstallEnv } from '../../install/env'
import { AGENT_HOOK_TIMEOUT_S, type AgentHome, type JsonAgentFile, jsonAgentWiring, stdioMcpEntry } from '../families/json-agent'
import type { McpEntrySpec } from '../families/mcp-entry'
import type { AgentProfile, Capabilities } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: true, prompt: true }, search: true, observer: false }

export const GEMINI_CLI_HOME: AgentHome = {
  variable: 'GEMINI_CLI_HOME',
  resolve: (env) => resolveAgentHome('GEMINI_CLI_HOME', env.geminiCliHomeEnv, env.homeDir, env.cwd),
  unset: (env) => ({ ...env, geminiCliHomeEnv: undefined }),
}

/** An unusable GEMINI_CLI_HOME reads as the default; install skips Gemini CLI and status says why. */
function settingsPath(env: InstallEnv): string {
  const home = GEMINI_CLI_HOME.resolve(env)
  return join(home.ok ? home.dir : env.homeDir, '.gemini', 'settings.json')
}

const MCP: McpEntrySpec = { path: settingsPath, key: 'mcpServers', entry: stdioMcpEntry() }

export const GEMINI_CLI_FILES: readonly JsonAgentFile[] = [
  {
    path: settingsPath,
    hooks: {
      shape: 'gemini',
      host: 'gemini-cli',
      label: 'Gemini CLI settings.json',
      events: ['SessionStart', 'BeforeAgent', 'AfterTool', 'AfterAgent', 'SessionEnd'],
      hooksKey: 'hooks',
      timeoutS: AGENT_HOOK_TIMEOUT_S,
      windowsShell: 'powershell',
    },
    mcp: MCP,
  },
]

export const GEMINI_CLI_PROFILE: AgentProfile = {
  id: 'gemini-cli',
  name: 'Gemini CLI',
  family: 'gemini-style',
  verification: 'docs',
  capabilities: () => CAPABILITIES,
  limit: () => null,
  shortLimit: () => null,
  detection: { binaries: ['gemini'] },
  wiring: jsonAgentWiring('gemini-cli', GEMINI_CLI_FILES, GEMINI_CLI_HOME),
  manualSteps: () => [],
}
