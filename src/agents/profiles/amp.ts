// Amp: a plugin file, ~/.config/amp/plugins/kinfold.ts, that hands Amp's
// events to Kinfold's hook, and the MCP server under "amp.mcpServers" in
// ~/.config/amp/settings.json. Built from the Amp docs, checked 2026-11-13:
//   ampcode.com/manual/plugins (system plugins in $XDG_CONFIG_HOME/amp/plugins/
//     when XDG_CONFIG_HOME is set, else ~/.config/amp/plugins/, which is
//     %USERPROFILE%\.config\amp\plugins\ on Windows; a .ts file loads with Bun;
//     `amp plugins list` shows what loaded)
//   ampcode.com/manual/plugin-api (the events and their payloads;
//     agent.start may return a message appended to the user's turn;
//     session.start returns nothing; only amp.experimental is marked unstable,
//     and the plugin uses none of it)
//   ampcode.com/docs/markdown/cli/settings and /customize/mcp (user settings in
//     ~/.config/amp/settings.json or settings.jsonc, servers under
//     "amp.mcpServers" with command, args, env)
// The plugin is agents/families/amp-plugin.ts and the parser
// src/adapters/amp.ts. The research marked the whole plugin API experimental;
// the current docs mark only amp.experimental, so Amp ships with context.
// A plugin that fails to load shows only in Amp (`amp plugins list`); nothing
// Kinfold can read records it, so the limit names that check. The settings
// page names no variable for the settings folder (XDG_CONFIG_HOME is named for
// plugins only), and a settings.jsonc is never merged: with one present the
// MCP server is left to the user.

import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { type InstallEnv, errorMessage } from '../../install/env'
import { ampPluginContent } from '../families/amp-plugin'
import { type JsonAgentFile, jsonAgentFileInstallActions, jsonAgentFileUninstallActions, mcpEntryText, stdioMcpEntry } from '../families/json-agent'
import { hookTarget } from '../families/json-hooks'
import { mcpEntryState } from '../families/mcp-entry'
import { type PluginFileSpec, pluginFileActions, pluginFileLine, pluginFileState, pluginFileUninstallActions } from '../families/plugin-file'
import type { AgentProfile, Capabilities } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: true, prompt: true }, search: true, observer: false }

const LIMIT = 'a plugin that fails to load shows only in Amp; run `amp plugins list` to check that kinfold loaded'

const HOST = 'amp'

const ampDir = (env: InstallEnv): string => join(env.homeDir, '.config', 'amp')

/** XDG_CONFIG_HOME counts only as an absolute path, as the XDG spec has it. */
export function ampPluginDir(env: InstallEnv): string {
  const xdg = env.xdgConfigHomeEnv
  return xdg !== undefined && xdg !== '' && isAbsolute(xdg) ? join(xdg, 'amp', 'plugins') : join(ampDir(env), 'plugins')
}

export const AMP_PLUGIN_SPEC: PluginFileSpec = {
  dir: ampPluginDir,
  fileName: 'kinfold.ts',
  host: HOST,
  label: 'Amp',
  template: (env) => ampPluginContent(hookTarget(env, HOST).entry),
}

const settingsPath = (env: InstallEnv): string => join(ampDir(env), 'settings.json')
const jsoncPath = (env: InstallEnv): string => join(ampDir(env), 'settings.jsonc')
const hasJsonc = (env: InstallEnv): boolean => existsSync(jsoncPath(env))

export const AMP_MCP_FILE: JsonAgentFile = {
  path: settingsPath,
  mcp: { path: settingsPath, key: 'amp.mcpServers', entry: stdioMcpEntry() },
}

/** Where an install without XDG_CONFIG_HOME put the plugin, when that is elsewhere. */
const defaultSpecEnv = (env: InstallEnv): InstallEnv => ({ ...env, xdgConfigHomeEnv: undefined })

function mcpLine(env: InstallEnv): string {
  if (hasJsonc(env)) return `MCP skipped (${jsoncPath(env)} found; add the entry by hand)`
  return AMP_MCP_FILE.mcp === undefined ? '' : `MCP ${mcpEntryState(env, AMP_MCP_FILE.mcp, HOST)} in ${settingsPath(env)}`
}

export const AMP_PROFILE: AgentProfile = {
  id: HOST,
  name: 'Amp',
  family: 'custom',
  verification: 'docs',
  capabilities: () => CAPABILITIES,
  limit: () => LIMIT,
  shortLimit: () => 'Run `amp plugins list` to check that the plugin loaded.',
  detection: { binaries: ['amp'] },
  wiring: {
    install: async (env, options) => {
      const plugin = await pluginFileActions(env, AMP_PLUGIN_SPEC, options?.opencodeAssets).catch((error: unknown) => {
        // A foreign kinfold.ts skips Amp's plugin, not the whole install.
        env.out(`${HOST}: plugin skipped; ${errorMessage(error)}`)
        return []
      })
      if (!hasJsonc(env)) return [...plugin, ...jsonAgentFileInstallActions(env, HOST, AMP_MCP_FILE)]
      env.out(`${HOST}: ${jsoncPath(env)} found; add the kinfold MCP server under "amp.mcpServers" there by hand, no settings.json was written`)
      return plugin
    },
    uninstall: (env) => {
      const moved = ampPluginDir(env) !== ampPluginDir(defaultSpecEnv(env))
      return [
        ...pluginFileUninstallActions(env, AMP_PLUGIN_SPEC),
        ...(moved ? pluginFileUninstallActions(defaultSpecEnv(env), AMP_PLUGIN_SPEC) : []),
        ...jsonAgentFileUninstallActions(env, HOST, AMP_MCP_FILE),
      ]
    },
    // A plugin file by our name that is not ours is not our wiring.
    state: (env) => {
      const state = pluginFileState(env, AMP_PLUGIN_SPEC)
      return state === 'foreign' ? 'unknown' : state
    },
    line: (env) => `plugin ${pluginFileLine(env, AMP_PLUGIN_SPEC)}; ${mcpLine(env)}`,
  },
  manualSteps: (_os, env) => [
    `amp: run \`amp plugins list\` after installing to check that the kinfold plugin loaded; if your settings live in settings.jsonc, add the kinfold server under "amp.mcpServers" there by hand (Kinfold never edits JSONC): ${AMP_MCP_FILE.mcp === undefined ? '' : mcpEntryText(AMP_MCP_FILE.mcp, env, HOST)}`,
  ],
}
