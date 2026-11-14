// Factory Droid: Claude-style command hooks in ~/.factory/hooks.json and the
// MCP server in ~/.factory/mcp.json. Built from the Factory docs, checked
// 2026-11-13:
//   docs.factory.com/reference/hooks-reference (events, the common fields,
//     hookSpecificOutput.additionalContext on SessionStart and PostToolUse,
//     "additionalContext is appended" on UserPromptSubmit, timeouts in seconds)
//   docs.factory.com/cli/configuration/mcp (~/.factory/mcp.json, mcpServers
//     with type stdio, command, args and env)
// hooks.json is keyed by event name with no "hooks" wrapper; when it exists
// Droid ignores the hooks key in settings.json, so the entries go in
// hooks.json. The docs list no PostToolUseFailure and no `args`, so the entry
// is one shell string. The only stdin example is for PreToolUse; the
// fixtures in test/fixtures/factory-droid/ reuse its common fields with each
// event's documented ones (docs-constructed-*.json).
// The docs name no shell for Windows, so the single-quoted command an install
// writes is unchecked there; until a real run shows it works, Windows gets no
// hooks and search only.

import { join } from 'node:path'
import { platformOf } from '../../install/env'
import type { OsName } from '../../platform/platform'
import { AGENT_HOOK_TIMEOUT_S, type JsonAgentFile, jsonAgentWiring, mcpServersFile } from '../families/json-agent'
import { type AgentProfile, type Capabilities, SHORT_WINDOWS_HOOKS_UNCHECKED } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: true, prompt: true }, search: true, observer: false }
const WINDOWS_CAPABILITIES: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false }

const WINDOWS_LIMIT = 'no hooks on Windows: Factory\'s docs name no Windows shell, and the hook command is not yet checked against one'

const onWindows = (os: OsName): boolean => os === 'windows'

export const FACTORY_DROID_FILES: readonly JsonAgentFile[] = [
  {
    path: (env) => join(env.homeDir, '.factory', 'hooks.json'),
    when: (env) => !onWindows(platformOf(env).os),
    hooks: {
      shape: 'command',
      grouped: true,
      host: 'factory-droid',
      label: 'Factory hooks.json',
      events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'],
      hooksKey: null,
      timeoutS: AGENT_HOOK_TIMEOUT_S,
      matchers: { PostToolUse: '*' },
    },
  },
  mcpServersFile((env) => join(env.homeDir, '.factory', 'mcp.json'), { type: 'stdio' }),
]

export const FACTORY_DROID_PROFILE: AgentProfile = {
  id: 'factory-droid',
  name: 'Factory Droid',
  family: 'claude-style',
  verification: 'docs',
  capabilities: (os) => (onWindows(os) ? WINDOWS_CAPABILITIES : CAPABILITIES),
  limit: (os) => (onWindows(os) ? WINDOWS_LIMIT : null),
  shortLimit: (os) => (os === 'windows' ? SHORT_WINDOWS_HOOKS_UNCHECKED : null),
  detection: { binaries: ['droid'] },
  wiring: jsonAgentWiring('factory-droid', FACTORY_DROID_FILES),
  manualSteps: () => [],
}
