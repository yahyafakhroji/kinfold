// Augment's Auggie CLI: command hooks and the MCP server, both in
// ~/.augment/settings.json, planned as one write. Built from the Auggie docs,
// checked 2026-11-13:
//   docs.augmentcode.com/cli/hooks (events SessionStart, PromptSubmit,
//     PostToolUse, Stop, SessionEnd; { hooks: { Event: [ { matcher?, hooks:
//     [ { type: "command", command, args?, timeout (ms) } ] } ] } }; with
//     `args` the command runs directly with no shell, on Windows too;
//     SessionStart, PromptSubmit, Stop and SessionEnd run in the background
//     and SessionStart output is not added to the agent's context; only
//     PostToolUse returns additionalContext; PromptSubmit carries
//     user_prompt)
//   docs.augmentcode.com/cli/integrations (MCP servers under "mcpServers" in
//     ~/.augment/settings.json, with command, args, env)
//   docs.augmentcode.com/cli/reference (the `auggie` binary; the
//     --augment-cache-dir flag moves ~/.augment for one run; no environment
//     variable moves it)
// The research had capture as partial; the docs show the prompt text on
// PromptSubmit and every event carrying the conversation id, so capture is
// full. The docs don't say PromptSubmit's output reaches the agent, so no
// context is claimed: the hook prints nothing. Hooks are written with `args`,
// so no shell quoting is involved and Windows gets them as well.

import { join } from 'node:path'
import { AUGGIE_EVENTS } from '../../adapters/auggie'
import { AGENT_HOOK_TIMEOUT_S, type JsonAgentFile, jsonAgentWiring, stdioMcpEntry } from '../families/json-agent'
import type { AgentProfile, Capabilities } from '../profile'

const HOST = 'auggie'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: false, prompt: false }, search: true, observer: false }

const LIMIT = 'Auggie runs session-start and prompt hooks in the background and adds nothing they print, so no context is injected; the assistant\'s reply is not recorded'

const settingsPath = (env: { homeDir: string }): string => join(env.homeDir, '.augment', 'settings.json')

export const AUGGIE_FILE: JsonAgentFile = {
  path: settingsPath,
  hooks: {
    shape: 'claude',
    host: HOST,
    label: 'Auggie settings.json',
    events: AUGGIE_EVENTS,
    hooksKey: 'hooks',
    timeoutS: AGENT_HOOK_TIMEOUT_S,
    timeoutUnit: 'ms',
  },
  mcp: { path: settingsPath, key: 'mcpServers', entry: stdioMcpEntry() },
}

export const AUGGIE_PROFILE: AgentProfile = {
  id: HOST,
  name: 'Auggie',
  family: 'claude-style',
  verification: 'docs',
  capabilities: () => CAPABILITIES,
  limit: () => LIMIT,
  shortLimit: () => "Hook output never reaches the agent, and the assistant's reply is not recorded.",
  detection: { binaries: ['auggie'] },
  wiring: jsonAgentWiring(HOST, [AUGGIE_FILE]),
  manualSteps: (_os, env) => [
    `auggie: if you start Auggie with --augment-cache-dir, copy the kinfold entries under "hooks" and "mcpServers" from ${settingsPath(env)} into that folder's settings.json`,
  ],
}
