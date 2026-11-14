// Codex CLI: command hooks in hooks.json under CODEX_HOME (default ~/.codex).
// Built from the Codex hooks docs (learn.chatgpt.com/docs/hooks, read
// 2026-10-25) and codex-rs/hooks/src/schema.rs; see src/adapters/codex.ts.
// Its observer can run on the user's own `codex` login.

import { CODEX_TRUST_NOTE, codexHookUninstallActions, hostHookInstallActions, hostWiringLine, hostWiringState } from '../../install/host-wiring'
import type { AgentProfile, Capabilities } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: true, prompt: true }, search: true, observer: true }

export const CODEX_PROFILE: AgentProfile = {
  id: 'codex',
  name: 'Codex',
  family: 'command-hooks',
  verification: 'live',
  capabilities: () => CAPABILITIES,
  limit: () => null,
  detection: { binaries: ['codex'], bundles: ['Codex.app'] },
  wiring: {
    install: async (env) => hostHookInstallActions(env, 'codex'),
    uninstall: (env) => codexHookUninstallActions(env),
    state: (env) => hostWiringState(env, 'codex'),
    line: (env) => hostWiringLine(env, 'codex'),
  },
  // Codex skips a hook the user has not reviewed in /hooks.
  manualSteps: () => [CODEX_TRUST_NOTE],
}
