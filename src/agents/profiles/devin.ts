// Devin (CLI and Desktop, Windsurf's successor): Claude-style command hooks
// under "hooks" in the user config and the MCP server in the user's
// mcp_config.json. Built from the Devin docs, checked 2026-11-13:
//   docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks (events, session_id
//     and prompt_id on every payload, tool_response { success, output, error },
//     hookSpecificOutput.additionalContext on SessionStart and UserPromptSubmit)
//   docs.devin.ai/cli/extensibility/hooks/overview.md (user hooks under
//     "hooks" in ~/.config/devin/config.json, %APPDATA%\devin\config.json on
//     Windows; entries { matcher?, hooks: [{ type, command, timeout (s) }] },
//     no `args`; an omitted matcher matches every tool; Devin also loads
//     ~/.claude.json and ~/.claude/settings*.json hooks, on by default through
//     read_config_from.claude)
//   docs.devin.ai/desktop/cascade/hooks
//   docs.devin.ai/cli/extensibility/mcp/configuration.md (user scope
//     ~/.config/devin/mcp_config.json, %APPDATA%\devin\mcp_config.json on
//     Windows, from v3000.3; mcpServers with command, args and env; `devin`)
// Because Devin also runs Claude Code's user hooks (overview.md, "Hooks from
// .claude/ paths are loaded when read_config_from.claude is enabled (the
// default)"), alsoFiresFrom names Claude Code: with Claude Code wired, install
// writes Devin's MCP entry only, and the Claude Code hook records an event as
// Devin's when DEVIN_PROJECT_DIR, which overview.md says Devin sets for its
// command hooks, is present and the payload has no transcript_path (which
// Claude Code always sends). Turning that source off is
//   docs.devin.ai/cli/reference/configuration/read-config-from.md
//     ({ "read_config_from": { "claude": false } }, each source true by default)
// so with it false Devin keeps hooks of its own. The docs list no PostToolUseFailure, and no cwd or hook_event_name on
// the payload; test/fixtures/devin/ assumes both, as Claude Code's format, in
// docs-constructed-*.json.
// The docs name no shell for Windows, so the single-quoted command an install
// writes is unchecked there; until a real run shows it works, Windows gets no
// hooks and search only.

import { join } from 'node:path'
import { type InstallEnv, errorMessage, platformOf } from '../../install/env'
import type { OsName } from '../../platform/platform'
import { readPlainJsonObject } from '../families/plain-json'
import { AGENT_HOOK_TIMEOUT_S, type JsonAgentFile, jsonAgentWiring, mcpServersFile } from '../families/json-agent'
import { type AgentProfile, type Capabilities, SHORT_WINDOWS_HOOKS_UNCHECKED } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: true, prompt: true }, search: true, observer: false }
const WINDOWS_CAPABILITIES: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false }

const WINDOWS_LIMIT = 'no hooks on Windows: Devin\'s docs name no Windows shell, and the hook command is not yet checked against one'

const onWindows = (os: OsName): boolean => os === 'windows'

/**
 * Claude Code's entries run kinfold through command plus args; Devin's docs
 * list matcher, type, command and timeout only, so whether those args reach
 * the hook is unknown.
 */
export const DEVIN_ARGS_CAVEAT = 'Devin records through Claude Code\'s hook entries only if it passes their args (Devin\'s docs list matcher, type, command and timeout only), unverified until a live run'

const LIMIT = `Devin also runs Claude Code's user hooks, so with Claude Code wired it gets no hooks of its own; ${DEVIN_ARGS_CAVEAT}`

/** %APPDATA% is the user's Roaming folder. */
function devinDir(env: InstallEnv): string {
  return platformOf(env).os === 'windows' ? join(env.homeDir, 'AppData', 'Roaming', 'devin') : join(env.homeDir, '.config', 'devin')
}

const devinConfigPath = (env: InstallEnv): string => join(devinDir(env), 'config.json')

export const DEVIN_FILES: readonly JsonAgentFile[] = [
  {
    path: (env) => devinConfigPath(env),
    when: (env) => !onWindows(platformOf(env).os),
    hooks: {
      shape: 'command',
      grouped: true,
      host: 'devin',
      label: 'Devin config.json',
      events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'],
      hooksKey: 'hooks',
      timeoutS: AGENT_HOOK_TIMEOUT_S,
    },
  },
  mcpServersFile((env) => join(devinDir(env), 'mcp_config.json')),
]

const KEEP_ON = 'keep read_config_from.claude on in Devin (the default), or Devin records nothing'

/**
 * read_config_from.claude in the user config (default true) decides whether
 * Devin runs Claude Code's hooks. A file that is not plain JSON is taken as the
 * default, and the note says so; a project's .devin/config.json can turn it
 * off too, which install can't see.
 */
function firesFromClaude(env: InstallEnv): { fires: boolean; note: string } {
  const path = devinConfigPath(env)
  let value: unknown
  try {
    const file = readPlainJsonObject(path)
    value = file.exists ? file.value.read_config_from : undefined
  } catch (error: unknown) {
    return { fires: true, note: `could not read read_config_from.claude from ${path} (${errorMessage(error)}); taken as on, the default: ${KEEP_ON}` }
  }
  const claude = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).claude : undefined
  if (claude === false) return { fires: false, note: `read_config_from.claude is false in ${path}, so Devin skips Claude Code's hooks and keeps hooks of its own` }
  return { fires: true, note: KEEP_ON }
}

export const DEVIN_PROFILE: AgentProfile = {
  id: 'devin',
  name: 'Devin',
  family: 'claude-style',
  verification: 'docs',
  capabilities: (os) => (onWindows(os) ? WINDOWS_CAPABILITIES : CAPABILITIES),
  limit: (os) => (onWindows(os) ? WINDOWS_LIMIT : LIMIT),
  shortLimit: (os) => (os === 'windows' ? SHORT_WINDOWS_HOOKS_UNCHECKED : "Runs Claude Code's hooks when Claude Code is wired; not yet checked on a live run."),
  detection: { binaries: ['devin'] },
  wiring: jsonAgentWiring('devin', DEVIN_FILES),
  manualSteps: () => [],
  alsoFiresFrom: 'claude-code',
  firesFrom: firesFromClaude,
}
