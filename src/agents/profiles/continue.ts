// Continue (IDE extension and `cn` CLI): the MCP server is a manual step.
// Built from the Continue docs, checked 2026-11-13:
//   docs.continue.dev/customize/deep-dives/mcp (servers live in YAML: an
//     `mcpServers` list in config.yaml, or a block file under
//     .continue/mcpServers/; a JSON config is read only from
//     .continue/mcpServers/ in the workspace)
// The user-level config is YAML, which Kinfold has no safe writer for, and the
// JSON route is per workspace, inside a repo, where Kinfold never writes. So
// nothing is written and the manual step prints the YAML block. Search
// waits on that block, so the profile claims none, as Goose's does.
// Detection: Continue is an extension of VS Code or JetBrains, and a
// ~/.continue folder is written by other tools too, so it never counts. The
// docs pages checked name no `cn` install or version probe, so there is no
// safe signal: detection finds nothing and --hosts continue names it.

import { type InstallEnv } from '../../install/env'
import { MCP_SERVER_NAME } from '../../install/mcp-config'
import { mcpTarget } from '../../install/mcp-wiring'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import type { AgentProfile, Capabilities } from '../profile'

const HOST = 'continue'

const CAPABILITIES: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: false, observer: false }

/** A JSON string is a valid YAML double-quoted scalar, so paths and arguments keep their exact text. */
export function continueYamlBlock(env: InstallEnv): string {
  const { command, args } = mcpTarget(env).entry
  return [
    'mcpServers:',
    `  - name: ${MCP_SERVER_NAME}`,
    `    command: ${JSON.stringify(command)}`,
    `    args: ${JSON.stringify(args)}`,
    '    env:',
    `      ${MCP_HOST_ENV}: ${JSON.stringify(HOST)}`,
  ].join('\n')
}

const STEP_COMMAND = 'kinfold install --hosts continue --dry-run'

/** What install prints for Continue, since a status run never lists an agent it neither found nor wired. */
const addBlockStep = (env: InstallEnv): string =>
  `continue: add this to the mcpServers list in ~/.continue/config.yaml (or save it as .continue/mcpServers/kinfold.yaml with name, version and schema: v1 above it):\n${continueYamlBlock(env)}`

export const CONTINUE_PROFILE: AgentProfile = {
  id: HOST,
  name: 'Continue',
  family: 'mcp-only',
  verification: 'docs',
  capabilities: () => CAPABILITIES,
  limit: () => 'Continue has no hooks; search needs the MCP block added to ~/.continue/config.yaml by hand',
  detection: async (_env, forced) =>
    forced
      ? { host: HOST, selected: true, version: null, note: 'wired because --hosts names it' }
      : { host: HOST, selected: false, version: null, note: 'no safe signal for an IDE extension; name it with --hosts continue' },
  wiring: {
    install: async (env) => {
      env.out(`${HOST}: its MCP servers live in YAML, which Kinfold doesn't edit, so nothing was written. ${addBlockStep(env)}`)
      return []
    },
    uninstall: () => [],
    state: () => 'no',
    line: () => `MCP not written (YAML config); run \`${STEP_COMMAND}\` to print the block to add`,
  },
  manualSteps: (_os, env) => [addBlockStep(env)],
}
