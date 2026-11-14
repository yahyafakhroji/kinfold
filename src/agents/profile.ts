// What every agent is described by. Types only plus two pure formatters, so the
// hook path can import this without pulling in installer code.

import type { KnownHost } from '../contract/event'
import type { WiringState } from '../install/claude-hooks'
import type { HostDetection, Semver } from '../install/detectors'
import type { InstallEnv } from '../install/env'
import type { Action } from '../install/plan'
import type { OsName } from '../platform/platform'
import type { EmbeddedAssets } from '../runtime/embedded'

export type AgentId = KnownHost
export type AgentFamily = 'claude-style' | 'gemini-style' | 'opencode-plugin' | 'command-hooks' | 'mcp-only' | 'custom'
export type CaptureLevel = 'full' | 'partial' | 'none'

export interface Capabilities {
  capture: CaptureLevel
  context: { sessionStart: boolean; prompt: boolean }
  search: boolean
  observer: boolean
}

/** `live` means recorded payloads exist in test/fixtures/<agent>/; `docs` means none do. */
export type Verification = 'live' | 'docs'

export interface DetectionSpec {
  binaries: readonly string[]
  bundles?: readonly string[]
  minVersion?: Semver
}

/** What an install run hands every agent's wiring; the OpenCode plugin bundle is injected by tests, since a checkout carries none. */
export interface WiringOptions {
  opencodeAssets?: EmbeddedAssets | null
}

export interface AgentWiring {
  install(env: InstallEnv, options?: WiringOptions): Promise<Action[]>
  uninstall(env: InstallEnv): Action[]
  state(env: InstallEnv): WiringState | 'unknown'
  line(env: InstallEnv): string
  /** The same agent with none of its own hooks (any it has come out) and the rest as usual, for an agent that already runs another agent's hooks. */
  withoutHooks?: () => AgentWiring
}

export interface AgentProfile {
  id: AgentId
  name: string
  family: AgentFamily
  verification: Verification
  capabilities(os: OsName): Capabilities
  /** Why the agent does less than a full integration on this OS, or null. */
  limit(os: OsName): string | null
  /** The limit in one short sentence that names no agent, for the README table's notes; null where limit is null. A profile with a limit on any OS has one. */
  shortLimit?(os: OsName): string | null
  detection: DetectionSpec | ((env: InstallEnv, forced: boolean) => Promise<HostDetection>)
  wiring: AgentWiring
  /** Steps the user takes by hand; any command in them is the one install would write on this env. */
  manualSteps(os: OsName, env: InstallEnv): readonly string[]
  /** The agent reads another agent's hook file, so its events may arrive under that agent's id. */
  alsoFiresFrom?: AgentId
  /** Whether the agent runs alsoFiresFrom's hooks on this env, from its own settings, and what status should say about that setting; absent means it always does. Install and status only, never the hook. */
  firesFrom?(env: InstallEnv): { fires: boolean; note: string }
}

/** Every agent's profile by id; tests pass one with an agent the real table lacks. */
export type ProfileTable = Readonly<Record<AgentId, AgentProfile>>

/** The short limit of every agent whose hooks stay off on Windows until its shell is checked. */
export const SHORT_WINDOWS_HOOKS_UNCHECKED = 'Hooks stay off on Windows until the hook command is checked against the shell the agent runs them in.'
export const SHORT_NO_HOOKS = 'The agent has no hooks.'

function contextPart(context: Capabilities['context']): string | null {
  if (context.sessionStart && context.prompt) return 'context at start and on each prompt'
  if (context.sessionStart) return 'context at start'
  if (context.prompt) return 'context on each prompt'
  return null
}

/** What the capabilities come to, without the limit: "captures, context at start, search", or '' for none. */
export function capabilitySummary(caps: Capabilities): string {
  const parts: string[] = []
  if (caps.capture === 'full') parts.push('captures')
  if (caps.capture === 'partial') parts.push('captures tool results only')
  const context = contextPart(caps.context)
  if (context) parts.push(context)
  if (caps.search) parts.push(parts.length === 0 ? 'search only' : 'search')
  return parts.join(', ')
}

export function capabilityLine(profile: AgentProfile, os: OsName): string {
  const line = capabilitySummary(profile.capabilities(os))
  const limit = profile.limit(os)
  // With nothing to list, the limit is the whole story.
  if (line === '') return limit ?? 'nothing wired'
  return limit === null ? line : `${line} (${limit})`
}

export function verificationNote(v: Verification): string | null {
  return v === 'docs' ? 'built from the docs, not yet checked against a real run' : null
}
