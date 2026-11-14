// Cline (the VS Code extension and the `cline` CLI): one executable hook file
// per event in ~/Documents/Cline/Hooks/, each a #!/bin/sh that execs Kinfold's
// hook, and the MCP server in the CLI's cline_mcp_settings.json. Built from
// the Cline docs and repository, checked 2026-11-13:
//   github.com/cline/cline/blob/main/.clinerules/hooks/README.md (the global
//     ~/Documents/Cline/Hooks/ folder; files named after the event, no
//     extension, a shebang, chmod +x; "Windows: Not currently supported";
//     VS Code runs hooks only with "Enable Hooks" checked; output
//     { cancel, contextModification }; TaskStart and UserPromptSubmit run
//     blocking in the extension and their contextModification is added)
//   github.com/cline/cline/blob/main/sdk/examples/hooks/README.md (the CLI
//     fires the same files; TaskStart and TaskResume are fire-and-forget there
//     unless the host opts in, and prompt_submit has no return channel)
//   sdk/packages/shared/src/storage/paths.ts (the CLI also reads
//     ~/Documents/Cline/Hooks/, so one folder serves both hosts)
//   docs.cline.bot/mcp/configuring-mcp-servers (the CLI's
//     ~/.cline/data/settings/cline_mcp_settings.json, mcpServers with command,
//     args, env, disabled; CLINE_MCP_SETTINGS_PATH moves it; the extension's
//     file is reached only through its MCP Servers panel, so it is a manual step)
// The parser is src/adapters/cline.ts. No variable moves the hooks folder.
// Per-prompt context is claimed for the extension, which reads it on
// UserPromptSubmit; the CLI doesn't, which the limit says. The extension runs
// TaskStart from beforeRun, once per submitted turn
// (apps/vscode/src/sdk/hooks-adapter.ts), where the docs say a new task, so
// the session pack could arrive every turn: TaskStart is still recorded as a
// session start, but asks for no context until a live run settles it.
// Detection is the `cline` binary: the extension is a VS Code folder, which
// never counts, so an extension-only user names cline with --hosts.

import { join, resolve } from 'node:path'
import { CLINE_HOOK_FILES } from '../../adapters/cline'
import { parseEntry } from '../../install/entry'
import { type InstallEnv, platformOf } from '../../install/env'
import type { Action } from '../../install/plan'
import type { OsName } from '../../platform/platform'
import { type JsonAgentFile, jsonAgentFileInstallActions, jsonAgentFileUninstallActions, mcpEntryText, stdioMcpEntry } from '../families/json-agent'
import { hookTarget, shellCommand } from '../families/json-hooks'
import { mcpEntryState } from '../families/mcp-entry'
import { type OwnedFileSpec, ownedFileActions, ownedFileUninstallActions, ownedFilesState } from '../families/owned-file'
import type { AgentProfile, Capabilities } from '../profile'
import { SHIM_MARKER } from '../../names'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: false, prompt: true }, search: true, observer: false }
const WINDOWS_CAPABILITIES: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false }

const LIMIT = 'session-start context is off until a live run confirms TaskStart fires once per task; TaskStart may be recorded on every turn; the Cline CLI runs UserPromptSubmit without reading its output, so context reaches the VS Code extension only'
const WINDOWS_LIMIT = 'Cline\'s hooks don\'t run on Windows'

const HOOK_MODE = 0o755
const HOST = 'cline'

const onWindows = (os: OsName): boolean => os === 'windows'

export const clineHooksDir = (env: InstallEnv): string => join(env.homeDir, 'Documents', 'Cline', 'Hooks')

function hookScript(env: InstallEnv): string {
  return ['#!/bin/sh', `# ${SHIM_MARKER}: written by \`kinfold install\`, removed by \`kinfold uninstall\`.`, `exec ${shellCommand(hookTarget(env, HOST).entry)}`, ''].join('\n')
}

/** Ours when its exec line runs Kinfold's hook for Cline, whichever checkout or program it names. */
function isOurScript(text: string): boolean {
  const exec = text.split('\n').find((line) => line.startsWith('exec '))
  const parsed = exec === undefined ? null : parseEntry(exec.slice('exec '.length), [])
  if (parsed?.role !== 'hook') return false
  const at = parsed.args.indexOf('--host')
  return at !== -1 && parsed.args[at + 1] === HOST
}

function hookFileSpecs(env: InstallEnv): OwnedFileSpec[] {
  const content = hookScript(env)
  return CLINE_HOOK_FILES.map((name) => ({ path: join(clineHooksDir(env), name), content, mode: HOOK_MODE, isOurs: isOurScript, noun: 'Kinfold hook file' }))
}

export function clineHookFileActions(env: InstallEnv): Action[] {
  return hookFileSpecs(env).flatMap((spec) => ownedFileActions(env, spec, HOST))
}

export function clineHookFileUninstallActions(env: InstallEnv): Action[] {
  return hookFileSpecs(env).flatMap((spec) => ownedFileUninstallActions(env, spec, HOST))
}

function mcpPath(env: InstallEnv): string {
  const moved = env.clineMcpSettingsPathEnv
  return moved !== undefined && moved !== '' ? resolve(env.cwd, moved) : join(env.homeDir, '.cline', 'data', 'settings', 'cline_mcp_settings.json')
}

export const CLINE_MCP_FILE: JsonAgentFile = {
  path: mcpPath,
  mcp: { path: mcpPath, key: 'mcpServers', entry: stdioMcpEntry({ disabled: false }) },
}

const windowsEnv = (env: InstallEnv): boolean => onWindows(platformOf(env).os)

function mcpLine(env: InstallEnv): string {
  return CLINE_MCP_FILE.mcp === undefined ? '' : `MCP ${mcpEntryState(env, CLINE_MCP_FILE.mcp, HOST)} in ${mcpPath(env)}`
}

export const CLINE_PROFILE: AgentProfile = {
  id: HOST,
  name: 'Cline',
  family: 'custom',
  verification: 'docs',
  capabilities: (os) => (onWindows(os) ? WINDOWS_CAPABILITIES : CAPABILITIES),
  limit: (os) => (onWindows(os) ? WINDOWS_LIMIT : LIMIT),
  detection: { binaries: ['cline'] },
  wiring: {
    install: async (env) => [...(windowsEnv(env) ? [] : clineHookFileActions(env)), ...jsonAgentFileInstallActions(env, HOST, CLINE_MCP_FILE)],
    uninstall: (env) => [...clineHookFileUninstallActions(env), ...jsonAgentFileUninstallActions(env, HOST, CLINE_MCP_FILE)],
    state: (env) => {
      if (!windowsEnv(env)) return ownedFilesState(env, hookFileSpecs(env))
      const mcp = CLINE_MCP_FILE.mcp === undefined ? 'no' : mcpEntryState(env, CLINE_MCP_FILE.mcp, HOST)
      return mcp === 'foreign' ? 'no' : mcp
    },
    line: (env) => (windowsEnv(env) ? mcpLine(env) : `hooks ${ownedFilesState(env, hookFileSpecs(env))} in ${clineHooksDir(env)}; ${mcpLine(env)}`),
  },
  manualSteps: (os, env) => [
    ...(onWindows(os) ? [] : ['cline: in VS Code, check "Enable Hooks" under Cline\'s Feature Settings; the extension runs no hook files without it']),
    `cline: the VS Code extension keeps its own MCP settings; add the kinfold server under "mcpServers" there through Cline's MCP Servers panel (Configure MCP Servers): ${CLINE_MCP_FILE.mcp === undefined ? '' : mcpEntryText(CLINE_MCP_FILE.mcp, env, HOST)}`,
  ],
}
