// Zed: the MCP server under "context_servers" in settings.json. Built from the
// Zed docs, checked 2026-11-13:
//   zed.dev/docs/ai/mcp (a local server is { command, args, env }; Zed has no
//     hooks, and its docs show no "source" key for it)
//   zed.dev/docs/configuring-zed (~/.config/zed/settings.json is the one path
//     the docs show; its examples carry // comments, and the default file_types
//     map treats settings.json as JSONC)
// The docs give no Windows settings path, so Windows is a manual step rather
// than a guessed file. A settings.json with comments or trailing commas is
// common and can't be merged safely: the writer refuses it untouched and the
// manual step prints the exact entry to paste. Zed hosts other agents over ACP
// and those are wired through their own profiles.

import { join } from 'node:path'
import { type InstallEnv, platformOf } from '../../install/env'
import { type JsonAgentFile, jsonAgentFileInstallActions, jsonAgentFileUninstallActions, mcpEntryText, stdioMcpEntry } from '../families/json-agent'
import { mcpEntryState } from '../families/mcp-entry'
import type { AgentProfile, Capabilities } from '../profile'

const HOST = 'zed'

const CAPABILITIES: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false }

const NO_WINDOWS_PATH = 'add the entry by hand, no Windows settings path is documented'

const isWindows = (env: InstallEnv): boolean => platformOf(env).os === 'windows'

const settingsPath = (env: InstallEnv): string => join(env.homeDir, '.config', 'zed', 'settings.json')

export const ZED_MCP_FILE: JsonAgentFile = {
  path: settingsPath,
  mcp: { path: settingsPath, key: 'context_servers', entry: stdioMcpEntry() },
}

const spec = ZED_MCP_FILE.mcp

export const ZED_PROFILE: AgentProfile = {
  id: HOST,
  name: 'Zed',
  family: 'mcp-only',
  verification: 'docs',
  capabilities: () => CAPABILITIES,
  limit: (os) => (os === 'windows' ? `Zed has no hooks; ${NO_WINDOWS_PATH}` : 'Zed has no hooks'),
  detection: { binaries: ['zed'], bundles: ['Zed.app'] },
  wiring: {
    install: async (env) => {
      if (!isWindows(env)) return jsonAgentFileInstallActions(env, HOST, ZED_MCP_FILE)
      env.out(`${HOST}: no Windows settings path is documented; add the entry by hand, nothing was written`)
      return []
    },
    uninstall: (env) => jsonAgentFileUninstallActions(env, HOST, ZED_MCP_FILE),
    state: (env) => {
      if (spec === undefined || isWindows(env)) return 'no'
      const state = mcpEntryState(env, spec, HOST)
      return state === 'foreign' ? 'no' : state
    },
    line: (env) => {
      if (isWindows(env)) return `MCP not written (${NO_WINDOWS_PATH})`
      return spec === undefined ? '' : `MCP ${mcpEntryState(env, spec, HOST)} in ${settingsPath(env)}`
    },
  },
  manualSteps: (os, env) => [
    `zed: ${os === 'windows' ? 'on Windows, or ' : ''}if your settings.json has comments or trailing commas (Kinfold never edits JSONC), add this under "context_servers" in Zed's settings: ${spec === undefined ? '' : mcpEntryText(spec, env, HOST)}`,
  ],
}
