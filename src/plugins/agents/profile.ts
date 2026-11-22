// What every agent is described by. Types only plus two pure formatters, so the
// hook path can import this without pulling in installer code.

import type { KnownHost } from '../contract/event'
import type { WiringState } from '../install/claude-hooks'
import type { HostDetection, Semver } from '../install/detectors'
import type { InstallEnv } from '../install/env'
import type { Action } from '../install/plan'
import type { ObserverProvider } from '../observer/types'
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

/**
 * Whether the agent's own CLI can run the observer on the user's login, and
 * if not, why. The observer reads untrusted session text, so a CLI qualifies
 * only with a real switch that turns every tool off, proven by a live run of
 * the planted-instruction check (observer/runners/CLI-LOGIN-CANDIDATES.md).
 */
export type ObserverLogin = { provider: ObserverProvider } | { out: string }

export const NO_TOOLS_OFF = 'its CLI has no switch that turns every tool off, so it could act on what a session says'
export const ACTS_HEADLESS = 'its CLI runs tools on its own in headless mode'
export const NO_HEADLESS = 'it has no headless CLI to run a summary through'

export interface AgentProfile {
  id: AgentId
  name: string
  observerLogin: ObserverLogin
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
  /** The agent shows the user no line Kinfold writes, so update news reaches its user only through status, the dashboard and kinfold watch. */
  updateNewsElsewhere?: true
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

/**
 * The same in three words at most, for a row that also carries a name and a
 * version: "capture, context, search". Status has the full line and the limit.
 */
export function capabilityBrief(profile: AgentProfile, os: OsName): string {
  const caps = profile.capabilities(os)
  const parts = [
    ...(caps.capture === 'full' ? ['capture'] : caps.capture === 'partial' ? ['partial capture'] : []),
    ...(contextPart(caps.context) ? ['context'] : []),
    ...(caps.search ? ['search'] : []),
  ]
  // The limit is a sentence for status; a row has room for a few words.
  return parts.length === 0 ? 'no automatic wiring' : parts.join(', ')
}

/** Where an agent with no line the user reads gets update news instead: no update notice goes into a model's context. */
export const UPDATE_NEWS_LIMIT = 'update news shows in kinfold status, the dashboard and kinfold watch, not in the agent'

export function capabilityLine(profile: AgentProfile, os: OsName): string {
  const caps = profile.capabilities(os)
  const line = capabilitySummary(caps)
  const own = profile.limit(os)
  // Only where its hooks run: an agent with none on this OS hears nothing from Kinfold at all.
  const hooked = caps.capture !== 'none' || caps.context.sessionStart || caps.context.prompt
  const news = profile.updateNewsElsewhere === true && hooked ? UPDATE_NEWS_LIMIT : null
  const limit = own === null ? news : news === null ? own : `${own}; ${news}`
  // With nothing to list, the limit is the whole story.
  if (line === '') return limit ?? 'nothing wired'
  return limit === null ? line : `${line} (${limit})`
}

export function verificationNote(v: Verification): string | null {
  return v === 'docs' ? 'built from the docs, not yet checked against a real run' : null
}
