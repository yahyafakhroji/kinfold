// Claude Code: hooks in ~/.claude/settings.json and the MCP server through
// `claude mcp`. Built from recorded payloads in test/fixtures/claude-code/
// (src/plugins/adapters/claude-code.ts), not from documentation. Its observer can run
// on the user's own `claude` login.

import { claudeHookInstallActions, claudeHookLine, claudeHookState, claudeHookUninstallActions } from '../../../resources/install-plan/claude-wiring'
import { detectClaudeCode } from '../../../resources/install-plan/detectors'
import { claudeMcpInstallActions, claudeMcpState, claudeMcpUninstallActions } from '../../../resources/install-plan/mcp-wiring'
import { legacyClaudeMcpRemoval } from '../../../resources/install-plan/rename-migration'
import type { AgentProfile, Capabilities } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: true, prompt: true }, search: true, observer: true }

export const CLAUDE_CODE_PROFILE: AgentProfile = {
  id: 'claude-code',
  name: 'Claude Code',
  observerLogin: { provider: 'claude-cli' },
  family: 'claude-style',
  verification: 'live',
  capabilities: () => CAPABILITIES,
  limit: () => null,
  // Claude Code counts by ~/.claude too: it is the one agent whose folder no other tool writes.
  detection: (env, forced) => detectClaudeCode(env, forced),
  wiring: {
    install: async (env) => {
      // The pre-rename MCP entry goes only after the kinfold one is written, so a failed step never leaves Claude Code without a memory server.
      const state = claudeMcpState(env)
      const legacy = state === 'yes' || state === 'no' || state === 'stale' ? legacyClaudeMcpRemoval(env) : []
      return [...claudeHookInstallActions(env), ...claudeMcpInstallActions(env), ...legacy]
    },
    uninstall: (env) => [...claudeHookUninstallActions(env), ...claudeMcpUninstallActions(env)],
    state: (env) => claudeHookState(env),
    line: (env) => claudeHookLine(env),
  },
  manualSteps: () => [],
}
