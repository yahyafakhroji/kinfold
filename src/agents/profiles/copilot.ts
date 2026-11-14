// GitHub Copilot (the CLI, and VS Code's agent hooks, which read the same
// ~/.copilot/hooks/ folder): command hooks in ~/.copilot/hooks/kinfold.json
// and the MCP server in ~/.copilot/mcp-config.json. Built from the docs,
// checked 2026-11-13:
//   docs.github.com/en/copilot/reference/hooks-reference (hook files, version
//     1, flat entries with command and timeout, PascalCase event names that
//     switch the payload to snake_case with hook_event_name, a top-level
//     additionalContext read on sessionStart, prompt hook output dropped)
//   code.visualstudio.com/docs/copilot/customization/hooks (~/.copilot/hooks/)
//   docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
//     (~/.copilot/mcp-config.json, mcpServers with type local, command, args,
//     env and tools)
// Both pages name only the repository's .claude/settings*.json, not the
// user's ~/.claude/settings.json, so Claude Code's user hooks never fire in
// Copilot and Copilot gets its own file. The reference gives type shapes, not
// literal payloads: test/fixtures/copilot/ holds docs-constructed-*.json.
// COPILOT_HOME moves the Copilot home: the hooks reference puts the user hooks
// folder at $COPILOT_HOME/hooks/ and the CLI reference keeps the user's files
// there, so both files follow it. The docs don't say whether the folder must
// exist; it is held to Codex's CODEX_HOME rule.
// On Windows the command is written for PowerShell (hook-shell.ts). The hooks
// reference, checked 2026-11-14, gives an entry `bash` ("Shell command for
// Unix.") and `powershell` ("Shell command for Windows."), with `command` the
// "Cross-platform fallback. Copied to both `bash` and `powershell` when those
// fields are absent". It also has a shell-free `exec` with `args`, "Only
// supported in Copilot CLI"; VS Code reads the same hooks folder, so the entry
// stays a `command` every surface runs.

import { join } from 'node:path'
import { resolveAgentHome } from '../../install/codex-home'
import type { InstallEnv } from '../../install/env'
import { AGENT_HOOK_TIMEOUT_S, type AgentHome, type JsonAgentFile, jsonAgentWiring, mcpServersFile } from '../families/json-agent'
import type { AgentProfile, Capabilities } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: true, prompt: false }, search: true, observer: false }

export const COPILOT_HOME: AgentHome = {
  variable: 'COPILOT_HOME',
  resolve: (env) => resolveAgentHome('COPILOT_HOME', env.copilotHomeEnv, join(env.homeDir, '.copilot'), env.cwd),
  unset: (env) => ({ ...env, copilotHomeEnv: undefined }),
}

/** An unusable COPILOT_HOME reads as the default; install skips Copilot and status says why. */
function copilotDir(env: InstallEnv): string {
  const home = COPILOT_HOME.resolve(env)
  return home.ok ? home.dir : join(env.homeDir, '.copilot')
}

export const COPILOT_FILES: readonly JsonAgentFile[] = [
  {
    path: (env) => join(copilotDir(env), 'hooks', 'kinfold.json'),
    // Kinfold's own file: once our hooks are out, only the version it carries is left.
    removeWhenOnly: ['version'],
    hooks: {
      shape: 'command',
      grouped: false,
      version: 1,
      host: 'copilot',
      label: 'Copilot hooks/kinfold.json',
      events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'],
      hooksKey: 'hooks',
      timeoutS: AGENT_HOOK_TIMEOUT_S,
      windowsShell: 'powershell',
    },
  },
  mcpServersFile((env) => join(copilotDir(env), 'mcp-config.json'), { type: 'local', tools: ['*'] }),
]

export const COPILOT_PROFILE: AgentProfile = {
  id: 'copilot',
  name: 'GitHub Copilot',
  family: 'claude-style',
  verification: 'docs',
  capabilities: () => CAPABILITIES,
  limit: () => null,
  shortLimit: () => null,
  detection: { binaries: ['copilot'] },
  wiring: jsonAgentWiring('copilot', COPILOT_FILES, COPILOT_HOME),
  manualSteps: () => [],
}
