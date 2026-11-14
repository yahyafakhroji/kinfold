// Crush (Charm): the MCP server under "mcp" in the global crush.json. Built
// from the Crush docs, checked 2026-11-13:
//   github.com/charmbracelet/crush/blob/main/docs/config/README.md (config is
//     crushrc, a Bash script run at start-up, at $XDG_CONFIG_HOME/crush/crushrc,
//     by default ~/.config/crush/crushrc and %USERPROFILE%\.config\crush\crushrc;
//     crush.json in the same folder is deprecated but supported; a folder
//     holding both merges them and logs a warning; `mcp add` / `hook add`)
//   github.com/charmbracelet/crush/blob/main/schema.json (crush.json's "mcp"
//     map of { type, command, args, env })
//   github.com/charmbracelet/crush/blob/main/docs/hooks/README.md (13 events;
//     SessionStart and TurnStart are observe-only and TurnStart carries no
//     prompt; only tool events take `context`; hooks run in Crush's embedded
//     POSIX shell on every OS)
// The research put hooks in crushrc. crushrc is Bash (conditionals, `source`,
// command substitution), which nothing short of a shell can read, so Kinfold
// can't refuse an unreadable one or find its own entries there the way the
// JSON writers do. Crush therefore ships search only, through crush.json, and
// the `hook add` lines are a manual step. A crush.json is never created
// beside an existing crushrc, which would make Crush warn on every start;
// the `mcp add` line is a manual step then. The parser for the hook lines is
// src/adapters/crush.ts.

import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { CRUSH_EVENTS } from '../../adapters/crush'
import { entryCommand } from '../../install/entry'
import type { InstallEnv } from '../../install/env'
import type { WiringState } from '../../install/claude-hooks'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import { AGENT_HOOK_TIMEOUT_S, type JsonAgentFile, jsonAgentFileInstallActions, jsonAgentFileUninstallActions, stdioMcpEntry } from '../families/json-agent'
import { hookTarget, shellCommand } from '../families/json-hooks'
import { mcpEntryState } from '../families/mcp-entry'
import type { AgentProfile, Capabilities } from '../profile'

const HOST = 'crush'

const CAPABILITIES: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false }

const LIMIT = 'Crush\'s hooks live in crushrc, a Bash script Kinfold can\'t merge safely; add the `hook add` lines by hand to record tool calls and turn ends; Crush sends no prompt text and takes no context at session start or on a prompt'

/** XDG_CONFIG_HOME counts only as an absolute path, as the XDG spec has it. */
export function crushConfigDir(env: InstallEnv): string {
  const xdg = env.xdgConfigHomeEnv
  return xdg !== undefined && xdg !== '' && isAbsolute(xdg) ? join(xdg, 'crush') : join(env.homeDir, '.config', 'crush')
}

const configPath = (env: InstallEnv): string => join(crushConfigDir(env), 'crush.json')
const crushrcPath = (env: InstallEnv): string => join(crushConfigDir(env), 'crushrc')

export const CRUSH_MCP_FILE: JsonAgentFile = {
  path: configPath,
  mcp: { path: configPath, key: 'mcp', entry: stdioMcpEntry({ type: 'stdio' }) },
}

/** Writing crush.json beside the user's crushrc would add a second config Crush warns about. */
const crushrcOnly = (env: InstallEnv): boolean => existsSync(crushrcPath(env)) && !existsSync(configPath(env))

/** Where an install without XDG_CONFIG_HOME wrote. */
const defaultEnv = (env: InstallEnv): InstallEnv => ({ ...env, xdgConfigHomeEnv: undefined })

function mcpState(env: InstallEnv): WiringState | 'unknown' {
  if (CRUSH_MCP_FILE.mcp === undefined) return 'no'
  const state = mcpEntryState(env, CRUSH_MCP_FILE.mcp, HOST)
  return state === 'foreign' ? 'no' : state
}

/** One crushrc (Bash) word in double quotes; the hook command inside keeps its own single quotes. */
const bashWord = (value: string): string => `"${value.replace(/[\\"$`]/g, '\\$&')}"`

/** The lines that register the hook command and MCP server install would write, as crushrc commands. */
function crushrcSteps(env: InstallEnv): string {
  const hook = bashWord(shellCommand(hookTarget(env, HOST).entry))
  const mcp = entryCommand(env.mode, 'mcp', env.dataDir)
  return [
    `crush: Kinfold never edits crushrc. To record Crush sessions, add these lines to ${crushrcPath(env)}:`,
    ...CRUSH_EVENTS.map((event) => `  hook add ${event} --name kinfold --command ${hook} --timeout ${AGENT_HOOK_TIMEOUT_S}`),
    'If you keep your config in crushrc rather than crush.json, add the MCP server there too:',
    `  mcp add kinfold --command ${bashWord(mcp.command)} ${mcp.args.map((arg) => `--args ${bashWord(arg)}`).join(' ')} --env ${MCP_HOST_ENV} ${HOST}`,
  ].join('\n')
}

export const CRUSH_PROFILE: AgentProfile = {
  id: HOST,
  name: 'Crush',
  family: 'custom',
  verification: 'docs',
  capabilities: () => CAPABILITIES,
  limit: () => LIMIT,
  shortLimit: () => "Hooks live in crushrc, which Kinfold can't edit safely; add the `hook add` lines by hand to record tool calls.",
  detection: { binaries: ['crush'] },
  wiring: {
    install: async (env) => {
      if (!crushrcOnly(env)) return jsonAgentFileInstallActions(env, HOST, CRUSH_MCP_FILE)
      env.out(`${HOST}: ${crushrcPath(env)} found; add the kinfold MCP server there by hand with \`mcp add\`, no crush.json was written`)
      return []
    },
    uninstall: (env) => {
      const moved = configPath(env) !== configPath(defaultEnv(env))
      return [
        ...jsonAgentFileUninstallActions(env, HOST, CRUSH_MCP_FILE),
        ...(moved ? jsonAgentFileUninstallActions(defaultEnv(env), HOST, CRUSH_MCP_FILE) : []),
      ]
    },
    state: mcpState,
    line: (env) => (crushrcOnly(env) ? `MCP skipped (${crushrcPath(env)} found; add the entry by hand)` : `MCP ${mcpState(env)} in ${configPath(env)}`),
  },
  manualSteps: (_os, env) => [crushrcSteps(env)],
}
