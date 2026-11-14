// Antigravity (CLI `agy`, the App and the IDE, which share one hooks file):
// a hook definition named kinfold in ~/.gemini/config/hooks.json and the MCP
// server in ~/.gemini/config/mcp_config.json. Built from the Antigravity
// docs, checked 2026-11-13:
//   antigravity.google/docs/hooks.md (the global hooks.json, hooks keyed by
//     a hook name, events, the camelCase stdin, injectSteps honoured on
//     SessionStart, PreInvocation and PostInvocation, timeouts in seconds,
//     "" or "*" matching every tool, the copied SessionStart example in
//     test/fixtures/antigravity/docs-session-start.json)
//   antigravity.google/docs/mcp.md (~/.gemini/config/mcp_config.json for the
//     CLI and the IDE, mcpServers with command, args and env; the App names
//     its file only through "Copy Config File Path")
//   antigravity.google/docs/cli/reference (the `agy` binary; no variable
//     moves its config folder)
// The parser is src/adapters/antigravity.ts. The hooks page shows no tool
// output on PostToolUse, so tool calls are recorded without their output,
// which the capability line says. A prompt is the first PreInvocation of a
// run (invocationNum 0), and the docs don't say whether that count restarts
// each run; if it doesn't, later prompts never arrive as prompts. So no
// per-prompt context is claimed or printed, and the line says prompts may go
// unrecorded. The macOS bundle name comes from install
// guides, not the docs.
// Gemini CLI shares ~/.gemini but reads settings.json; Antigravity's files
// sit under config/, so neither writer touches the other's file.
// The docs don't say which shell runs a hook; until a Windows run is checked
// against the single-quoted command an install writes, Windows gets no hooks
// and search only.

import { join } from 'node:path'
import { ANTIGRAVITY_EVENTS } from '../../adapters/antigravity'
import { type InstallEnv, platformOf } from '../../install/env'
import type { OsName } from '../../platform/platform'
import { AGENT_HOOK_TIMEOUT_S, type JsonAgentFile, jsonAgentWiring, mcpServersFile } from '../families/json-agent'
import type { AgentProfile, Capabilities } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: true, prompt: false }, search: true, observer: false }
const WINDOWS_CAPABILITIES: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false }

const LIMIT = 'prompts after the first in a conversation may not be recorded until checked on a live run; Antigravity\'s hooks carry no tool output, so tool calls are recorded without it'
const WINDOWS_LIMIT = 'no hooks on Windows: the shell Antigravity runs them through is not documented, and the hook command is not yet checked against it'

const configDir = (env: InstallEnv): string => join(env.homeDir, '.gemini', 'config')

const onWindows = (os: OsName): boolean => os === 'windows'

export const ANTIGRAVITY_FILES: readonly JsonAgentFile[] = [
  {
    path: (env) => join(configDir(env), 'hooks.json'),
    when: (env) => !onWindows(platformOf(env).os),
    definition: { host: 'antigravity', events: ANTIGRAVITY_EVENTS, toolEvents: ['PostToolUse'], timeoutS: AGENT_HOOK_TIMEOUT_S },
  },
  mcpServersFile((env) => join(configDir(env), 'mcp_config.json')),
]

export const ANTIGRAVITY_PROFILE: AgentProfile = {
  id: 'antigravity',
  name: 'Antigravity',
  family: 'gemini-style',
  verification: 'docs',
  capabilities: (os) => (onWindows(os) ? WINDOWS_CAPABILITIES : CAPABILITIES),
  limit: (os) => (onWindows(os) ? WINDOWS_LIMIT : LIMIT),
  detection: { binaries: ['agy'], bundles: ['Antigravity.app'] },
  wiring: jsonAgentWiring('antigravity', ANTIGRAVITY_FILES),
  manualSteps: () => [],
}
