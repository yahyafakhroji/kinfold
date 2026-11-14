// Goose: an Open Plugins plugin of our own, ~/.agents/plugins/kinfold/, whose
// hooks/hooks.json runs Kinfold's hook. Built from the Goose docs, checked
// 2026-11-13 (the repository moved to github.com/aaif-goose/goose):
//   goose-docs.ai/docs/guides/context-engineering/hooks/ (user plugins in
//     ~/.agents/plugins/<name>/, discovered without an enable step; a hooks
//     plugin must have hooks/hooks.json, { hooks: { Event: [ { matcher?,
//     hooks: [ { type: "command", command, timeout (s) } ] } ] } }; no
//     matcher matches everything; commands run with `sh -c`; most events are
//     observe-only and no hook output reaches the model; Windows is not
//     covered; no variable moves the plugin folder)
//   github.com/aaif-goose/goose examples/plugins/hello-hooks (a root
//     plugin.json with name, version, description)
//   agent-plugins.org/plugin-builders/installation (the Open Plugins spec:
//     every plugin has a root plugin.json)
//   goose-docs.ai/docs/getting-started/using-extensions/ (MCP servers are
//     extensions in ~/.config/goose/config.yaml, YAML only; no command adds
//     one for good without prompts)
// The parser is src/adapters/goose.ts. The docs show a working folder on tool
// events only, so only those are registered and capture is tool results only. Kinfold never edits YAML, so
// the MCP server is a manual step. Goose's hook runner calls `sh` on Windows
// too, which the docs don't cover, so Windows gets nothing until a live run.
// Detection is the `goose` binary, unless its --version answer is the
// database migration tool that shares the name (detectors.ts).

import { join } from 'node:path'
import { GOOSE_EVENTS } from '../../adapters/goose'
import { isRecord } from '../../contract/event'
import { detectGoose } from '../../install/detectors'
import { entryCommand, parseEntry } from '../../install/entry'
import { type InstallEnv, platformOf } from '../../install/env'
import type { Action } from '../../install/plan'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import type { OsName } from '../../platform/platform'
import { AGENT_HOOK_TIMEOUT_S } from '../families/json-agent'
import { hookTarget, shellCommand } from '../families/json-hooks'
import { type OwnedFileSpec, ownedFileActions, ownedFilesState, ownedFileUninstallActions } from '../families/owned-file'
import type { AgentProfile, Capabilities } from '../profile'

const HOST = 'goose'
const FILE_MODE = 0o644
const PLUGIN_NAME = 'kinfold'
const MANIFEST_DESCRIPTION = 'Records goose sessions in Kinfold; written by `kinfold install`, removed by `kinfold uninstall`.'

const CAPABILITIES: Capabilities = { capture: 'partial', context: { sessionStart: false, prompt: false }, search: false, observer: false }
const WINDOWS_CAPABILITIES: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: false, observer: false }

const LIMIT = 'Goose documents a working folder on tool events only and no hook output reaching the model, so only the tool events are registered: tool calls are recorded, with their output only if Goose sends it, and no context is injected; search needs the MCP server added to config.yaml by hand'
const WINDOWS_LIMIT = 'nothing is wired on Windows: Goose runs hooks with sh -c, and its docs don\'t cover Windows; search needs the MCP server added to config.yaml by hand'

const onWindows = (os: OsName): boolean => os === 'windows'
const windowsEnv = (env: InstallEnv): boolean => onWindows(platformOf(env).os)

export const goosePluginDir = (env: InstallEnv): string => join(env.homeDir, '.agents', 'plugins', PLUGIN_NAME)
export const goosePluginManifestPath = (env: InstallEnv): string => join(goosePluginDir(env), 'plugin.json')
export const gooseHooksPath = (env: InstallEnv): string => join(goosePluginDir(env), 'hooks', 'hooks.json')

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function hooksContent(env: InstallEnv): string {
  const command = shellCommand(hookTarget(env, HOST).entry)
  const hooks = Object.fromEntries(GOOSE_EVENTS.map((event) => [event, [{ hooks: [{ type: 'command', command, timeout: AGENT_HOOK_TIMEOUT_S }] }]]))
  return json({ hooks })
}

const isOurCommand = (command: unknown): boolean => {
  if (typeof command !== 'string') return false
  const entry = parseEntry(command, [])
  const at = entry?.role === 'hook' ? entry.args.indexOf('--host') : -1
  return at !== -1 && entry?.args[at + 1] === HOST
}

/** Ours when it holds hooks and every one of them runs Kinfold's hook for Goose. */
function isOurHooks(text: string): boolean {
  const value = parsed(text)
  if (!isRecord(value) || !isRecord(value.hooks)) return false
  const actions = Object.values(value.hooks).flatMap((rules) => (Array.isArray(rules) ? rules : [null])).flatMap((rule) => (isRecord(rule) && Array.isArray(rule.hooks) ? rule.hooks : [null]))
  return actions.length > 0 && actions.every((action) => isRecord(action) && isOurCommand(action.command))
}

/** The manifest runs nothing, so it is ours by our plugin name and the description we write. */
function isOurManifest(text: string): boolean {
  const value = parsed(text)
  return isRecord(value) && value.name === PLUGIN_NAME && value.description === MANIFEST_DESCRIPTION
}

function fileSpecs(env: InstallEnv): OwnedFileSpec[] {
  return [
    { path: goosePluginManifestPath(env), content: json({ name: PLUGIN_NAME, version: '1.0.0', description: MANIFEST_DESCRIPTION }), mode: FILE_MODE, isOurs: isOurManifest, noun: 'Kinfold plugin manifest' },
    { path: gooseHooksPath(env), content: hooksContent(env), mode: FILE_MODE, isOurs: isOurHooks, noun: 'Kinfold hook file' },
  ]
}

export function gooseFileActions(env: InstallEnv): Action[] {
  return fileSpecs(env).flatMap((spec) => ownedFileActions(env, spec, HOST))
}

export function gooseFileUninstallActions(env: InstallEnv): Action[] {
  return fileSpecs(env).flatMap((spec) => ownedFileUninstallActions(env, spec, HOST))
}

/** The extension as one YAML flow mapping; JSON strings are valid YAML scalars, so paths need no further quoting. */
function mcpStep(env: InstallEnv): string {
  const entry = entryCommand(env.mode, 'mcp', env.dataDir)
  return [
    'goose: Kinfold never edits YAML, so add its MCP server to ~/.config/goose/config.yaml by hand, under `extensions:`:',
    `  ${PLUGIN_NAME}: { name: ${PLUGIN_NAME}, type: stdio, cmd: ${JSON.stringify(entry.command)}, args: ${JSON.stringify(entry.args)}, envs: { ${MCP_HOST_ENV}: ${HOST} }, enabled: true, timeout: 300 }`,
  ].join('\n')
}

export const GOOSE_PROFILE: AgentProfile = {
  id: HOST,
  name: 'Goose',
  family: 'custom',
  verification: 'docs',
  capabilities: (os) => (onWindows(os) ? WINDOWS_CAPABILITIES : CAPABILITIES),
  limit: (os) => (onWindows(os) ? WINDOWS_LIMIT : LIMIT),
  shortLimit: (os) => (os === 'windows' ? 'Nothing is wired on Windows; search needs the MCP server added to config.yaml by hand.' : 'Records tool calls only; search needs the MCP server added to config.yaml by hand.'),
  detection: detectGoose,
  wiring: {
    install: async (env) => (windowsEnv(env) ? [] : gooseFileActions(env)),
    uninstall: (env) => gooseFileUninstallActions(env),
    state: (env) => (windowsEnv(env) ? 'no' : ownedFilesState(env, fileSpecs(env))),
    line: (env) => {
      const mcp = 'MCP by hand in ~/.config/goose/config.yaml'
      return windowsEnv(env) ? `nothing wired on Windows; ${mcp}` : `plugin ${ownedFilesState(env, fileSpecs(env))} in ${goosePluginDir(env)}; ${mcp}`
    },
  },
  manualSteps: (_os, env) => [mcpStep(env)],
}
