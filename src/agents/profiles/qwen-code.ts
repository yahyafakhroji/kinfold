// Qwen Code: Claude-style command hooks and the MCP server, both in
// ~/.qwen/settings.json, so one plan writes them. Built from the Qwen Code
// docs, checked 2026-11-13:
//   qwenlm.github.io/qwen-code-docs/en/users/features/hooks/ (events, the
//     common fields, hookSpecificOutput.additionalContext on SessionStart,
//     UserPromptSubmit and the tool events, timeouts in seconds, `async`)
//   qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/ (the
//     ~/.qwen/settings.json path, mcpServers with command, args and env)
// The hooks page lists command, name, timeout and async, and no `args`, so the
// entry is one shell string. It says "", "*" and ".*" match every tool but not
// what an absent matcher does, so the tool events carry "*". Neither page
// shows a stdin example, so test/fixtures/qwen-code/ holds payloads built from
// the documented fields (docs-constructed-*.json).
// Qwen Code is a Gemini CLI fork, and Gemini CLI runs hooks through PowerShell
// on Windows, where the single-quoted command an install writes would be a
// string, not a call; until that is checked against a real run, Windows gets
// no hooks and search only.

import { join } from 'node:path'
import { type InstallEnv, platformOf } from '../../install/env'
import type { OsName } from '../../platform/platform'
import type { McpEntrySpec } from '../families/mcp-entry'
import { AGENT_HOOK_TIMEOUT_S, type JsonAgentFile, jsonAgentWiring, stdioMcpEntry } from '../families/json-agent'
import { type AgentProfile, type Capabilities, SHORT_WINDOWS_HOOKS_UNCHECKED } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: true, prompt: true }, search: true, observer: false }
const WINDOWS_CAPABILITIES: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false }

const WINDOWS_LIMIT = 'no hooks on Windows: Qwen Code, a Gemini CLI fork, may run them through PowerShell, which the hook command is not yet checked against'

const onWindows = (os: OsName): boolean => os === 'windows'

const settingsPath = (env: InstallEnv): string => join(env.homeDir, '.qwen', 'settings.json')

const MCP: McpEntrySpec = { path: settingsPath, key: 'mcpServers', entry: stdioMcpEntry() }

// The same file twice: hooks and MCP off Windows, MCP alone on it. Uninstall
// clears both out of it once, whichever OS installed.
export const QWEN_CODE_FILES: readonly JsonAgentFile[] = [
  {
    path: settingsPath,
    when: (env) => !onWindows(platformOf(env).os),
    hooks: {
      shape: 'command',
      grouped: true,
      host: 'qwen-code',
      label: 'Qwen Code settings.json',
      events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'],
      hooksKey: 'hooks',
      timeoutS: AGENT_HOOK_TIMEOUT_S,
      asyncEvents: ['PostToolUse', 'PostToolUseFailure'],
      matchers: { PostToolUse: '*', PostToolUseFailure: '*' },
    },
    mcp: MCP,
  },
  { path: settingsPath, when: (env) => onWindows(platformOf(env).os), mcp: MCP },
]

export const QWEN_CODE_PROFILE: AgentProfile = {
  id: 'qwen-code',
  name: 'Qwen Code',
  family: 'claude-style',
  verification: 'docs',
  capabilities: (os) => (onWindows(os) ? WINDOWS_CAPABILITIES : CAPABILITIES),
  limit: (os) => (onWindows(os) ? WINDOWS_LIMIT : null),
  shortLimit: (os) => (os === 'windows' ? SHORT_WINDOWS_HOOKS_UNCHECKED : null),
  detection: { binaries: ['qwen'] },
  wiring: jsonAgentWiring('qwen-code', QWEN_CODE_FILES),
  manualSteps: () => [],
}
