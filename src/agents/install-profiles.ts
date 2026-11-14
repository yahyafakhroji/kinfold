// One table of install profiles, keyed by agent id. Install-side only: the hook
// command never imports this, since the profiles pull in installer code. Every
// id in KNOWN_HOSTS has a profile, which the type holds a new id to, so
// detection, the wizard and status list every agent Kinfold knows.

import type { HookHostSpec } from './hook-spec'
import { DEVIN_HOOK_ENV, HOOK_SPECS } from './hook-specs'
import type { WiringState } from '../install/claude-hooks'
import type { InstallEnv } from '../install/env'
import type { AgentId, AgentProfile, AgentWiring, ProfileTable } from './profile'
import { AMP_PROFILE } from './profiles/amp'
import { AUGGIE_PROFILE } from './profiles/auggie'
import { ANTIGRAVITY_PROFILE } from './profiles/antigravity'
import { CLINE_PROFILE } from './profiles/cline'
import { CLAUDE_CODE_PROFILE } from './profiles/claude-code'
import { CODEX_PROFILE } from './profiles/codex'
import { COPILOT_PROFILE } from './profiles/copilot'
import { CURSOR_PROFILE } from './profiles/cursor'
import { CRUSH_PROFILE } from './profiles/crush'
import { DEVIN_ARGS_CAVEAT, DEVIN_PROFILE } from './profiles/devin'
import { FACTORY_DROID_PROFILE } from './profiles/factory-droid'
import { GEMINI_CLI_PROFILE } from './profiles/gemini-cli'
import { GOOSE_PROFILE } from './profiles/goose'
import { JUNIE_PROFILE } from './profiles/junie'
import { KILO_CODE_PROFILE } from './profiles/kilo-code'
import { KIMI_CODE_PROFILE } from './profiles/kimi-code'
import { KIRO_PROFILE } from './profiles/kiro'
import { OPENCODE_PROFILE } from './profiles/opencode'
import { QWEN_CODE_PROFILE } from './profiles/qwen-code'
import { CONTINUE_PROFILE } from './profiles/continue'
import { WARP_PROFILE } from './profiles/warp'
import { ZED_PROFILE } from './profiles/zed'

export const INSTALL_PROFILES: ProfileTable = {
  'claude-code': CLAUDE_CODE_PROFILE,
  opencode: OPENCODE_PROFILE,
  codex: CODEX_PROFILE,
  cursor: CURSOR_PROFILE,
  'gemini-cli': GEMINI_CLI_PROFILE,
  'qwen-code': QWEN_CODE_PROFILE,
  'factory-droid': FACTORY_DROID_PROFILE,
  devin: DEVIN_PROFILE,
  'kilo-code': KILO_CODE_PROFILE,
  cline: CLINE_PROFILE,
  copilot: COPILOT_PROFILE,
  antigravity: ANTIGRAVITY_PROFILE,
  junie: JUNIE_PROFILE,
  kiro: KIRO_PROFILE,
  amp: AMP_PROFILE,
  'kimi-code': KIMI_CODE_PROFILE,
  auggie: AUGGIE_PROFILE,
  goose: GOOSE_PROFILE,
  crush: CRUSH_PROFILE,
  zed: ZED_PROFILE,
  continue: CONTINUE_PROFILE,
  warp: WARP_PROFILE,
}

export function profileOf(id: AgentId): AgentProfile {
  return INSTALL_PROFILES[id]
}

/** Every profile, in KNOWN_HOSTS order. */
export function builtProfiles(): AgentProfile[] {
  return Object.values(INSTALL_PROFILES)
}

export interface OverlapPlan {
  /** Agents whose own hook entries install leaves out (and takes out), because they run another selected agent's hooks. */
  skip: readonly AgentId[]
  /** The status line for each of them: under whose name their events are recorded. */
  notes: Readonly<Partial<Record<AgentId, string>>>
}

/**
 * Which agents would fire twice with `selected` wired: each one whose
 * alsoFiresFrom agent is among them runs that agent's hooks already, so a
 * second entry of its own would record every event twice.
 */
export function overlapPlan(
  selected: readonly AgentId[],
  env?: InstallEnv,
  profiles: ProfileTable = INSTALL_PROFILES,
  specs: Readonly<Record<AgentId, HookHostSpec | null>> = HOOK_SPECS,
): OverlapPlan {
  const skip: AgentId[] = []
  const notes: Partial<Record<AgentId, string>> = {}
  for (const profile of Object.values(profiles)) {
    const from = profile.alsoFiresFrom
    if (from === undefined || !selected.includes(from)) continue
    const fromName = profiles[from].name
    // Without an env (a plan for no machine in particular) the agent's default holds.
    const setting = env === undefined ? undefined : profile.firesFrom?.(env)
    if (setting !== undefined && !setting.fires) {
      notes[profile.id] = setting.note
      continue
    }
    const relabels = specs[from]?.callerOf !== undefined
    const recorded = relabels
      ? `${profile.name} runs ${fromName}'s hooks, so it has no hook entry of its own; its events are recorded as ${profile.name}'s when ${overlapSignal(profile.id)}, otherwise as ${fromName}'s`
      : `${profile.name} runs ${fromName}'s hooks, so it has no hook entry of its own; its events are recorded as ${fromName}'s`
    const base = profile.id === 'devin' ? `${recorded}; ${DEVIN_ARGS_CAVEAT}` : recorded
    skip.push(profile.id)
    notes[profile.id] = setting === undefined ? base : `${base}; ${setting.note}`
  }
  return { skip, notes }
}

/** The documented signal each relabelled agent sends, for the status note. */
function overlapSignal(id: AgentId): string {
  return id === 'devin' ? `it sets ${DEVIN_HOOK_ENV} for the hook` : 'the hook can tell it apart'
}

/** The wiring install and status use for an agent: without its own hooks when the overlap plan skips it. */
export function overlapWiring(profile: AgentProfile, plan: OverlapPlan): AgentWiring {
  return plan.skip.includes(profile.id) ? (profile.wiring.withoutHooks?.() ?? profile.wiring) : profile.wiring
}

const WIRED: readonly (WiringState | 'unknown')[] = ['yes', 'stale', 'partial']

/** Kinfold's wiring for the agent is in place, current or not. */
export function isWired(state: WiringState | 'unknown'): boolean {
  return WIRED.includes(state)
}

/** Anything but a clean 'no': a config that can't be read may still hold our entries. */
export function hasWiring(state: WiringState | 'unknown'): boolean {
  return state !== 'no'
}

/**
 * An agent's wiring state, counting one wired without hooks of its own: with
 * the agent whose hooks it runs wired, its MCP entry decides. Hooks of its own
 * still in place are reported as they are.
 */
export function overlapState(env: InstallEnv, profile: AgentProfile, profiles: ProfileTable = INSTALL_PROFILES): WiringState | 'unknown' {
  const own = profile.wiring.state(env)
  const from = profile.alsoFiresFrom === undefined ? null : profiles[profile.alsoFiresFrom]
  if (own !== 'no' || from === null || profile.wiring.withoutHooks === undefined) return own
  if (profile.firesFrom?.(env).fires === false) return own
  return isWired(from.wiring.state(env)) ? profile.wiring.withoutHooks().state(env) : own
}
