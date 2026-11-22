// Kilo Code (the CLI, 7.x): a plugin file in Kilo's own plugin folder, the
// recall toast, and an MCP entry. Checked live on Kilo CLI 7.8.27 in a
// throwaway HOME (payloads in test/fixtures/kilo-code/):
//   ~/.config/kilo/plugin/ loads every .js file at startup, on OpenCode's 1.x
//     plugin contract: the default export must be { id, server }, and a 2.x
//     plugin ({ id, setup }) is rejected ("must default export an object
//     with server()"). Kinfold up to 0.4 wrote OpenCode's plugin here, so it
//     captured nothing; Kilo now gets its own (src/plugins/plugins/kilo.ts), and an
//     install over the old file replaces it.
//   the plugin's experimental.chat.system.transform adds the context pack,
//     and what other sessions wrote since, to each request: seen reaching the
//     model live. The capability line counts it as context at start and on
//     each prompt.
//   ~/.config/kilo/tui.json lists TUI plugins under "plugin"; Kinfold's toast
//     is one entry there (families/kilo-tui.ts), shown live.
//   kilo.ai/docs/automate/mcp/using-in-kilo-code (servers under `mcp` in
//     ~/.config/kilo/kilo.json(c), { type: "local", command: [...], environment })
// The docs name no Windows folder and no variable that moves the config
// folder, so the folder is ~/.config/kilo on every OS (the way OpenCode's is)
// and detection is `kilo --version`. Kilo's plugin is JS that Kilo itself
// runs, so no shell quoting is involved on Windows.
// Kilo's docs say its config is kilo.json(c) "or the legacy opencode.json(c)"
// and that it no longer reads .opencode folders, so we cannot assume Kilo reads
// OpenCode's file: Kilo always gets its own `mcp.kinfold` in kilo.json. Both
// files use the same server key, so even a merged read cannot register twice.
// Unverified, and said so in limit() and manualSteps(): the Windows config
// folder (the docs say it may differ), any variable that moves the config
// folder (none documented), and kilo.jsonc (a JSONC file can't be merged
// safely, so with one present we write no kilo.json and leave the MCP entry
// to the user).

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type InstallEnv, errorMessage } from '../../../resources/install-plan/env'
import { openCodeMcpEntry } from '../../../resources/install-plan/mcp-config'
import { MCP_HOST_ENV } from '../../../controllers/mcp/read-reporter'
import { PLUGIN_FILE_NAME } from '../../../system/names'
import { type PluginFileSpec, pluginFileActions, pluginFileLine, pluginFileState, pluginFileUninstallActions } from '../families/plugin-file'
import { kiloTuiInstallActions, kiloTuiLine, kiloTuiUninstallActions } from '../families/kilo-tui'
import { type JsonAgentFile, jsonAgentFileInstallActions, jsonAgentFileUninstallActions, mcpEntryText } from '../families/json-agent'
import { mcpEntryState } from '../families/mcp-entry'
import { type AgentProfile, type Capabilities, NO_TOOLS_OFF } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: true, prompt: true }, search: true, observer: false }

const kiloDir = (env: InstallEnv): string => join(env.homeDir, '.config', 'kilo')

export const KILO_PLUGIN_SPEC: PluginFileSpec = { dir: (env) => join(kiloDir(env), 'plugin'), fileName: PLUGIN_FILE_NAME, host: 'kilo-code', label: 'Kilo Code', plugin: 'kilo' }

const configPath = (env: InstallEnv): string => join(kiloDir(env), 'kilo.json')

export const KILO_MCP_FILE: JsonAgentFile = {
  path: configPath,
  mcp: { path: configPath, key: 'mcp', entry: (target) => ({ ...openCodeMcpEntry(target), environment: { [MCP_HOST_ENV]: 'kilo-code' } }) },
}

const jsoncPath = (env: InstallEnv): string => join(kiloDir(env), 'kilo.jsonc')
const hasJsonc = (env: InstallEnv): boolean => existsSync(jsoncPath(env))

export const KILO_CODE_PROFILE: AgentProfile = {
  id: 'kilo-code',
  name: 'Kilo Code',
  observerLogin: { out: NO_TOOLS_OFF },
  family: 'opencode-plugin',
  verification: 'live',
  capabilities: () => CAPABILITIES,
  limit: (os) =>
    os === 'windows'
      ? 'Windows config folder unverified (the Kilo docs say it may differ); no config-folder variable honoured'
      : 'no config-folder variable honoured',
  shortLimit: (os) => (os === 'windows' ? 'The Windows config folder is unconfirmed, and no environment variable moves it.' : "The config folder can't be moved with an environment variable."),
  detection: { binaries: ['kilo'] },
  wiring: {
    install: async (env, options) => {
      const plugin = await pluginFileActions(env, KILO_PLUGIN_SPEC, options?.opencodeAssets).catch((error: unknown) => {
        // A plugin file Kilo's install doesn't own skips the plugin, not the whole install.
        env.out(`kilo-code: plugin skipped; ${errorMessage(error)}`)
        return []
      })
      // The toast shows what the plugin recorded; with no plugin there is nothing to show.
      const toast = plugin.length > 0 || pluginFileState(env, KILO_PLUGIN_SPEC) === 'yes' ? kiloTuiInstallActions(env) : []
      if (!hasJsonc(env)) return [...plugin, ...toast, ...jsonAgentFileInstallActions(env, 'kilo-code', KILO_MCP_FILE)]
      env.out(`kilo-code: ${jsoncPath(env)} found; add the kinfold MCP entry there by hand, no kilo.json was written`)
      return [...plugin, ...toast]
    },
    uninstall: (env) => [...pluginFileUninstallActions(env, KILO_PLUGIN_SPEC), ...kiloTuiUninstallActions(env), ...jsonAgentFileUninstallActions(env, 'kilo-code', KILO_MCP_FILE)],
    // A plugin file by our name that is not ours is not our wiring.
    state: (env) => {
      const state = pluginFileState(env, KILO_PLUGIN_SPEC)
      return state === 'foreign' ? 'unknown' : state
    },
    line: (env) => {
      const mcp = hasJsonc(env)
        ? `MCP skipped (${jsoncPath(env)} found; add the entry by hand)`
        : KILO_MCP_FILE.mcp === undefined ? '' : `MCP ${mcpEntryState(env, KILO_MCP_FILE.mcp, 'kilo-code')} in ${configPath(env)}`
      return `plugin ${pluginFileLine(env, KILO_PLUGIN_SPEC)}; ${kiloTuiLine(env)}; ${mcp}`
    },
  },
  manualSteps: (_os, env) => [
    `kilo-code: if your Kilo settings live in kilo.jsonc, add the kinfold MCP server under "mcp" there by hand (Kinfold never edits JSONC): ${KILO_MCP_FILE.mcp === undefined ? '' : mcpEntryText(KILO_MCP_FILE.mcp, env, 'kilo-code')}; a folder variable or a non-default Windows config folder is not followed`,
  ],
}
