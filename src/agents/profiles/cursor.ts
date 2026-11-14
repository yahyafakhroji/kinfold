// Cursor (IDE and cursor-agent): command hooks in ~/.cursor/hooks.json. Built
// from the Cursor hooks docs (cursor.com/docs/agent/hooks, read 2026-10-25,
// rechecked 2026-10-26) and public captures; see src/adapters/cursor.ts.
// Cursor takes context at session start only, and ships no CLI login the
// observer could borrow.
// On Windows the command is written for PowerShell (install/host-hooks.ts).
// The docs, checked 2026-11-14, confirm PowerShell for the desktop app only
// ("On Windows, the desktop app runs hook commands through PowerShell"); they
// don't say which shell cursor-agent uses there, and it gets the same form.

import { hostHookInstallActions, hostHookUninstallActions, hostWiringLine, hostWiringState } from '../../install/host-wiring'
import type { AgentProfile, Capabilities } from '../profile'

const CAPABILITIES: Capabilities = { capture: 'full', context: { sessionStart: true, prompt: false }, search: true, observer: false }

export const CURSOR_PROFILE: AgentProfile = {
  id: 'cursor',
  name: 'Cursor',
  family: 'command-hooks',
  verification: 'live',
  capabilities: () => CAPABILITIES,
  limit: () => null,
  detection: { binaries: ['cursor-agent', 'cursor'], bundles: ['Cursor.app'] },
  wiring: {
    install: async (env) => hostHookInstallActions(env, 'cursor'),
    uninstall: (env) => hostHookUninstallActions(env, 'cursor'),
    state: (env) => hostWiringState(env, 'cursor'),
    line: (env) => hostWiringLine(env, 'cursor'),
  },
  manualSteps: () => [],
}
