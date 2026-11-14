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
// On Windows Qwen Code picks the hook's shell from its surroundings (Git Bash
// under MSYS, else ComSpec, so cmd or PowerShell), which no one command string
// suits. The hooks page, checked 2026-11-14, documents a `shell` field,
// "bash" | "powershell", and the source runs a hook that names powershell as
// `powershell -Command <command>`:
//   github.com/QwenLM/qwen-code/blob/main/packages/core/src/hooks/hookRunner.ts
//     (getShellConfigForHook)
// So on Windows the entry names PowerShell as its shell and the command is
// written for it (hook-shell.ts).

import { join } from 'node:path'
import type { InstallEnv } from '../../install/env'
import type { McpEntrySpec } from '../families/mcp-entry'
import { AGENT_HOOK_TIMEOUT_S, type JsonAgentFile, jsonAgentWiring, stdioMcpEntry } from '../families/json-agent'
import type { AgentProfile, Capabilities } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: true, prompt: true }, search: true, observer: false }
const settingsPath = (env: InstallEnv): string => join(env.homeDir, '.qwen', 'settings.json')

const MCP: McpEntrySpec = { path: settingsPath, key: 'mcpServers', entry: stdioMcpEntry() }

export const QWEN_CODE_FILES: readonly JsonAgentFile[] = [
  {
    path: settingsPath,
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
      windowsShell: 'powershell',
      windowsEntry: { shell: 'powershell' },
    },
    mcp: MCP,
  },
]

export const QWEN_CODE_PROFILE: AgentProfile = {
  id: 'qwen-code',
  name: 'Qwen Code',
  family: 'claude-style',
  verification: 'docs',
  capabilities: () => CAPABILITIES,
  limit: () => null,
  shortLimit: () => null,
  detection: { binaries: ['qwen'] },
  wiring: jsonAgentWiring('qwen-code', QWEN_CODE_FILES),
  manualSteps: () => [],
}
