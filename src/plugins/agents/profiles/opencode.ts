// OpenCode: a plugin file under ~/.config/opencode/plugins (the V2 plugin
// contract, so 2.0 or later) and an MCP entry in opencode.json. Built from
// recorded payloads in test/fixtures/opencode/ (src/plugins/adapters/opencode.ts).
// The plugin captures every event itself, and takes no context back.

import { detectOpenCode } from '../../../resources/install-plan/detectors'
import { opencodeInstallActions, opencodeUninstallActions, opencodeWiringLine, opencodeWiringState } from '../../../resources/install-plan/host-wiring'
import { opencodeMcpInstallActions, opencodeMcpUninstallActions } from '../../../resources/install-plan/mcp-wiring'
import { legacyShimRemoval } from '../../../resources/install-plan/rename-migration'
import { opencodeTuiInstallActions, opencodeTuiUninstallActions } from '../families/opencode-tui'
import type { AgentProfile, Capabilities } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: false, prompt: false }, search: true, observer: true }

export const OPENCODE_PROFILE: AgentProfile = {
  id: 'opencode',
  name: 'OpenCode',
  observerLogin: { provider: 'opencode-cli' },
  family: 'opencode-plugin',
  verification: 'live',
  capabilities: () => CAPABILITIES,
  limit: () => null,
  // A 1.x OpenCode is refused even under --hosts, so the detector stays custom.
  detection: (env, forced) => detectOpenCode(env, forced),
  wiring: {
    install: async (env, options) => [...(await opencodeInstallActions(env, options?.opencodeAssets)), ...opencodeTuiInstallActions(env), ...opencodeMcpInstallActions(env), ...legacyShimRemoval(env)],
    uninstall: (env) => [...opencodeUninstallActions(env), ...opencodeTuiUninstallActions(env), ...opencodeMcpUninstallActions(env)],
    // A plugin file by our name that is not ours is not our wiring.
    state: (env) => {
      const state = opencodeWiringState(env)
      return state === 'foreign' ? 'unknown' : state
    },
    line: (env) => opencodeWiringLine(env),
  },
  manualSteps: () => [],
}
