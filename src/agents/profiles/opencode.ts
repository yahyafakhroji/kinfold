// OpenCode: a plugin file under ~/.config/opencode/plugins (the V2 plugin
// contract, so 2.0 or later) and an MCP entry in opencode.json. Built from
// recorded payloads in test/fixtures/opencode/ (src/adapters/opencode.ts).
// The plugin captures every event itself, and takes no context back.

import { detectOpenCode } from '../../install/detectors'
import { opencodeInstallActions, opencodeUninstallActions, opencodeWiringLine, opencodeWiringState } from '../../install/host-wiring'
import { opencodeMcpInstallActions, opencodeMcpUninstallActions } from '../../install/mcp-wiring'
import { legacyShimRemoval } from '../../install/rename-migration'
import type { AgentProfile, Capabilities } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: false, prompt: false }, search: true, observer: true }

export const OPENCODE_PROFILE: AgentProfile = {
  id: 'opencode',
  name: 'OpenCode',
  family: 'opencode-plugin',
  verification: 'live',
  capabilities: () => CAPABILITIES,
  limit: () => null,
  // A 1.x OpenCode is refused even under --hosts, so the detector stays custom.
  detection: (env, forced) => detectOpenCode(env, forced),
  wiring: {
    install: async (env, options) => [...(await opencodeInstallActions(env, options?.opencodeAssets)), ...opencodeMcpInstallActions(env), ...legacyShimRemoval(env)],
    uninstall: (env) => [...opencodeUninstallActions(env), ...opencodeMcpUninstallActions(env)],
    // A plugin file by our name that is not ours is not our wiring.
    state: (env) => {
      const state = opencodeWiringState(env)
      return state === 'foreign' ? 'unknown' : state
    },
    line: (env) => opencodeWiringLine(env),
  },
  manualSteps: () => [],
}
