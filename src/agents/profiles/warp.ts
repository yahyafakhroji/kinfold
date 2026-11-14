// Warp: its MCP servers come from ~/.warp/.mcp.json, or from the MCP configs
// of Claude Code and Codex. Built from the Warp docs, checked 2026-11-13:
//   docs.warp.dev/agent-platform/capabilities/mcp (Settings > Agents > MCP
//     servers; a CLI server is { command, args, env }; Warp's own files are
//     ~/.warp/.mcp.json and .warp/.mcp.json; it reads Claude Code's
//     ~/.claude.json and Codex's ~/.codex/config.toml too, and starts servers
//     from other agents' global files only with "Auto-spawn servers from
//     third-party agents" on)
// Warp has no hooks. With the Claude Code MCP entry in place Warp already
// reads it, so a second entry would only list the server twice and none is
// written. Codex counts too in principle, but Kinfold writes no MCP entry into
// Codex's config.toml, so only Claude Code's can be found. Otherwise the docs
// do name a user-level file, so ~/.warp/.mcp.json is merged like any JSON
// MCP file; the manual step gives the Settings route and the same entry.

import { join } from 'node:path'
import type { InstallEnv } from '../../install/env'
import { claudeMcpState } from '../../install/mcp-wiring'
import { type JsonAgentFile, jsonAgentFileInstallActions, jsonAgentFileUninstallActions, mcpEntryText, mcpServersFile } from '../families/json-agent'
import { mcpEntryState } from '../families/mcp-entry'
import type { AgentProfile, Capabilities } from '../profile'

const HOST = 'warp'

const CAPABILITIES: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false }

// Warp starts another agent's global servers only with this setting on.
const USES_CLAUDE = "uses the Claude Code entry (needs 'Auto-spawn servers from third-party agents' on in Warp)"

export const WARP_MCP_FILE: JsonAgentFile = mcpServersFile((env) => join(env.homeDir, '.warp', '.mcp.json'))

const spec = WARP_MCP_FILE.mcp

const usesClaudeEntry = (env: InstallEnv): boolean => claudeMcpState(env) === 'yes'

export const WARP_PROFILE: AgentProfile = {
  id: HOST,
  name: 'Warp',
  family: 'mcp-only',
  verification: 'docs',
  capabilities: () => CAPABILITIES,
  limit: () => 'Warp has no hooks',
  detection: { binaries: ['warp'], bundles: ['Warp.app'] },
  wiring: {
    install: async (env) => {
      if (!usesClaudeEntry(env)) return jsonAgentFileInstallActions(env, HOST, WARP_MCP_FILE)
      env.out(`${HOST}: ${USES_CLAUDE}; nothing was written`)
      return []
    },
    uninstall: (env) => jsonAgentFileUninstallActions(env, HOST, WARP_MCP_FILE),
    state: (env) => {
      // Not 'yes': Kinfold wrote nothing for Warp, and a wired agent gets observer settings and a status block of its own.
      if (usesClaudeEntry(env)) return 'no'
      if (spec === undefined) return 'no'
      const state = mcpEntryState(env, spec, HOST)
      return state === 'foreign' ? 'no' : state
    },
    line: (env) => {
      if (usesClaudeEntry(env)) return USES_CLAUDE
      return spec === undefined ? '' : `MCP ${mcpEntryState(env, spec, HOST)} in ${WARP_MCP_FILE.path(env)}`
    },
  },
  manualSteps: (_os, env) => [
    usesClaudeEntry(env)
      ? `warp: ${USES_CLAUDE}, so nothing to add`
      : `warp: if no entry was written, open Settings > Agents > MCP servers, choose + Add and paste: {"mcpServers": {${spec === undefined ? '' : mcpEntryText(spec, env, HOST)}}}`,
  ],
}
