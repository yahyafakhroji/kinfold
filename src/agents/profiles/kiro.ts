// Kiro (kiro-cli and the Kiro IDE): a v1 hook file of our own,
// ~/.kiro/hooks/kinfold.json, and the MCP server in ~/.kiro/settings/mcp.json.
// Built from the Kiro docs, checked 2026-11-13:
//   kiro.dev/docs/hooks/ (hook files are { version: "v1", hooks: [{ name,
//     trigger, action: { type: "command", command }, timeout (s) }] }, any
//     .json name; "Kiro CLI V3 also loads global Hooks from ~/.kiro/hooks/";
//     no matcher matches everything)
//   kiro.dev/docs/hooks/types/ (triggers and stdin; command stdout is said to
//     reach the agent only for agentSpawn and compaction)
//   kiro.dev/docs/cli/v3/hooks-migration/ (V3 trigger names; "To run the same
//     V3 Hook in every workspace, place it in ~/.kiro/hooks/")
//   kiro.dev/docs/mcp/configuration/ (~/.kiro/settings/mcp.json, mcpServers
//     with command, args, env)
// The research read the agentSpawn rule as covering SessionStart; the docs say
// it only under the agentSpawn heading and say nothing for Prompt Submit, so
// no context is claimed or printed on either. The IDE reads hooks only from a
// workspace's .kiro/hooks/, which install never writes, so that copy is a
// manual step. No variable moves ~/.kiro. The docs don't name the shell a
// command action runs in; until the single-quoted command is checked against
// a Windows run, Windows gets the MCP server only.

import { join } from 'node:path'
import { KIRO_EVENTS } from '../../adapters/kiro'
import { isRecord } from '../../contract/event'
import { parseEntry } from '../../install/entry'
import { type InstallEnv, platformOf } from '../../install/env'
import type { Action } from '../../install/plan'
import type { OsName } from '../../platform/platform'
import { AGENT_HOOK_TIMEOUT_S, type JsonAgentFile, jsonAgentFileInstallActions, jsonAgentFileUninstallActions, mcpServersFile } from '../families/json-agent'
import { hookTarget, shellCommand } from '../families/json-hooks'
import { mcpEntryState } from '../families/mcp-entry'
import { type OwnedFileSpec, ownedFileActions, ownedFileState, ownedFileUninstallActions } from '../families/owned-file'
import type { AgentProfile, Capabilities } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: false, prompt: false }, search: true, observer: false }
const WINDOWS_CAPABILITIES: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false }

const LIMIT = 'only Kiro CLI V3 reads ~/.kiro/hooks; Kiro\'s docs don\'t confirm hook output reaching the agent at session start or on a prompt, so no context is injected, and tool output is recorded only if Kiro sends it'
const WINDOWS_LIMIT = 'no hooks on Windows: the shell Kiro runs command hooks through is not documented, and the hook command is not yet checked against it'

const HOST = 'kiro'
const FILE_MODE = 0o644

const onWindows = (os: OsName): boolean => os === 'windows'
const windowsEnv = (env: InstallEnv): boolean => onWindows(platformOf(env).os)

export const kiroHooksPath = (env: InstallEnv): string => join(env.homeDir, '.kiro', 'hooks', 'kinfold.json')

function hooksContent(env: InstallEnv): string {
  const command = shellCommand(hookTarget(env, HOST).entry)
  const hooks = KIRO_EVENTS.map((trigger) => ({ name: `kinfold ${trigger}`, trigger, action: { type: 'command', command }, timeout: AGENT_HOOK_TIMEOUT_S }))
  return `${JSON.stringify({ version: 'v1', hooks }, null, 2)}\n`
}

const isOurCommand = (command: unknown): boolean => {
  if (typeof command !== 'string') return false
  const parsed = parseEntry(command, [])
  const at = parsed?.role === 'hook' ? parsed.args.indexOf('--host') : -1
  return at !== -1 && parsed?.args[at + 1] === HOST
}

/** Ours when every hook in it runs Kinfold's hook for Kiro. */
function isOurFile(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value) || !Array.isArray(value.hooks) || value.hooks.length === 0) return false
    return value.hooks.every((hook) => isRecord(hook) && isRecord(hook.action) && isOurCommand(hook.action.command))
  } catch {
    return false
  }
}

const hooksSpec = (env: InstallEnv): OwnedFileSpec => ({ path: kiroHooksPath(env), content: hooksContent(env), mode: FILE_MODE, isOurs: isOurFile, noun: 'Kinfold hook file' })

export function kiroHooksFileActions(env: InstallEnv): Action[] {
  return ownedFileActions(env, hooksSpec(env), HOST)
}

export function kiroHooksFileUninstallActions(env: InstallEnv): Action[] {
  return ownedFileUninstallActions(env, hooksSpec(env), HOST)
}

export const KIRO_MCP_FILE: JsonAgentFile = mcpServersFile((env) => join(env.homeDir, '.kiro', 'settings', 'mcp.json'))

function mcpState(env: InstallEnv): string {
  return KIRO_MCP_FILE.mcp === undefined ? 'no' : mcpEntryState(env, KIRO_MCP_FILE.mcp, HOST)
}

function hooksState(env: InstallEnv): 'yes' | 'no' | 'stale' {
  const state = ownedFileState(env, hooksSpec(env))
  return state === 'foreign' ? 'no' : state
}

export const KIRO_PROFILE: AgentProfile = {
  id: HOST,
  name: 'Kiro',
  family: 'custom',
  verification: 'docs',
  capabilities: (os) => (onWindows(os) ? WINDOWS_CAPABILITIES : CAPABILITIES),
  limit: (os) => (onWindows(os) ? WINDOWS_LIMIT : LIMIT),
  detection: { binaries: ['kiro-cli'], bundles: ['Kiro.app'] },
  wiring: {
    install: async (env) => [...(windowsEnv(env) ? [] : kiroHooksFileActions(env)), ...jsonAgentFileInstallActions(env, HOST, KIRO_MCP_FILE)],
    uninstall: (env) => [...kiroHooksFileUninstallActions(env), ...jsonAgentFileUninstallActions(env, HOST, KIRO_MCP_FILE)],
    state: (env) => {
      if (!windowsEnv(env)) return hooksState(env)
      const mcp = mcpState(env)
      return mcp === 'yes' || mcp === 'stale' || mcp === 'unknown' ? mcp : 'no'
    },
    line: (env) => {
      const mcp = `MCP ${mcpState(env)} in ${KIRO_MCP_FILE.path(env)}`
      return windowsEnv(env) ? mcp : `hooks ${hooksState(env)} in ${kiroHooksPath(env)}; ${mcp}`
    },
  },
  manualSteps: (os) =>
    onWindows(os)
      ? []
      : ['kiro: the Kiro IDE reads hooks only from a workspace; to capture IDE sessions, copy ~/.kiro/hooks/kinfold.json to <workspace>/.kiro/hooks/kinfold.json (Kiro CLI V3 already reads the global file, and runs both copies in that workspace)'],
}
