// The daemon's side of automatic updates. The daily check (check.ts) records
// the newest release; a tick here decides whether to apply it, and if so
// starts `kinfold update --auto` as a detached process (detach.ts), because
// the update stops this daemon. Only a patch release is applied, only after
// ten minutes with no agent event, and only once per daily check, so a
// failing update is retried a day later and never in a loop. The attempt is
// written before the updater starts: a daemon restarted by a half-finished
// update reads it and does not start another.

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { INSTALL_RECORD_FILE, type InstallRecord, readInstallRecord } from '../install/setup/record'
import type { OsName } from '../platform/platform'
import { type AutoUpdateState, lostAttempt, mergeAutoState, readAutoState } from './auto-state'
import { detachPlan, spawnDetached } from './detach'
import { autoUpdateSetting } from './enabled'
import { updateLockHolder } from './lock'
import { type UpdateState, readUpdateState } from './state'
import { compareVersions, isPatchUpdate, parseVersion } from './version-order'

type Env = Readonly<Record<string, string | undefined>>

/** How long no agent event may have arrived, so the restart never lands mid-session. */
export const QUIET_MS = 600_000
export const AUTO_TICK_MS = 60_000

export type AutoUpdateHold = 'off' | 'no-patch' | 'tried' | 'busy' | 'running' | 'blocked'
export type AutoUpdateDecision = { apply: true; version: string } | { apply: false; reason: AutoUpdateHold }

export interface AutoUpdateInput {
  running: string
  record: InstallRecord | null
  env: Env
  state: UpdateState
  auto: AutoUpdateState
  now: number
  lastEventAt: number
  /** The pid of an update that is running now; null for none. */
  lockHolder: number | null
  /** When this daemon began watching for updates; a blocker recorded before it gets one fresh try. Default: the beginning of time. */
  since?: number
  /** When install.json was last written; null when it cannot be told. */
  recordChangedAt?: number | null
}

/**
 * A recorded blocker still stands: same running version, recorded by this
 * daemon, and the install not touched since. Any of those changing is how a
 * blocker goes away (a service now runs the daemon, systemd-run was
 * installed and the daemon restarted), so each earns one new try.
 */
function stillBlocked(input: AutoUpdateInput): boolean {
  const failure = input.auto.failure
  if (failure === null || failure.blocked !== true || failure.running !== input.running) return false
  if (failure.at < (input.since ?? 0)) return false
  return input.recordChangedAt === undefined || input.recordChangedAt === null || input.recordChangedAt <= failure.at
}

export function autoUpdateDecision(input: AutoUpdateInput): AutoUpdateDecision {
  if (!autoUpdateSetting(input.running, input.record, input.env).on) return { apply: false, reason: 'off' }
  const latest = input.state.latestVersion
  if (latest === null || !isPatchUpdate(input.running, latest)) return { apply: false, reason: 'no-patch' }
  if (input.lockHolder !== null) return { apply: false, reason: 'running' }
  if (stillBlocked(input)) return { apply: false, reason: 'blocked' }
  // One attempt per check: only a later daily check, with its own time, allows the next.
  if (input.auto.attempt !== null && input.auto.attempt.checkedAt === input.state.checkedAt) return { apply: false, reason: 'tried' }
  if (input.now - input.lastEventAt < QUIET_MS) return { apply: false, reason: 'busy' }
  return { apply: true, version: latest }
}

export interface AutoUpdateDeps {
  dataDir: string
  /** The running version. */
  version: string
  /** The installed program, which is also the one this daemon runs. */
  program: string
  os: OsName
  now: () => number
  envVars: () => Env
  log: (line: string) => void
  /** When the last agent event reached the daemon. */
  lastEventAt: () => number
  /** Test seam; default spawnDetached. Returns the pid. */
  spawn?: (argv: string[], env: Env) => number
  /** Test seam for the detach plan's file checks. */
  exists?: (path: string) => boolean
  /** Test seam; default install.json's modification time. */
  recordChangedAt?: () => number | null
}

function recordMtime(dataDir: string): number | null {
  try {
    return statSync(join(dataDir, INSTALL_RECORD_FILE)).mtimeMs
  } catch {
    return null
  }
}

function start(deps: AutoUpdateDeps, version: string, checkedAt: number | null): 'started' | 'failed' {
  const env = deps.envVars()
  const at = deps.now()
  mergeAutoState(deps.dataDir, { attempt: { version, checkedAt, startedAt: at }, failure: null })
  const fail = (reason: string, blocked: boolean = false): 'failed' => {
    mergeAutoState(deps.dataDir, { failure: { version, at, reason, ...(blocked ? { blocked: true as const, running: deps.version } : {}) } })
    deps.log(`auto-update to ${version} not started: ${reason}`)
    return 'failed'
  }
  const plan = detachPlan({ os: deps.os, program: deps.program, args: ['--data-dir', deps.dataDir, 'update', '--auto'], envVars: env, ...(deps.exists !== undefined ? { exists: deps.exists } : {}) })
  // No detached run here is a fact about this machine, not a bad day: it is recorded once and waits for a change.
  if (!plan.ok) return fail(plan.reason, true)
  try {
    const pid = (deps.spawn ?? spawnDetached)(plan.argv, env)
    deps.log(`auto-update to ${version} started pid=${pid} via=${plan.via}`)
    return 'started'
  } catch (error: unknown) {
    // The name only: a spawn error's message carries the path.
    return fail(`could not start the updater (${error instanceof Error ? error.name : 'error'})`)
  }
}

function tickOnce(deps: AutoUpdateDeps, since: number): AutoUpdateHold | 'started' | 'failed' {
  const state = readUpdateState(deps.dataDir)
  const decision = autoUpdateDecision({
    running: deps.version,
    record: readInstallRecord(deps.dataDir),
    env: deps.envVars(),
    state,
    auto: readAutoState(deps.dataDir),
    now: deps.now(),
    lastEventAt: deps.lastEventAt(),
    lockHolder: updateLockHolder(deps.dataDir),
    since,
    recordChangedAt: (deps.recordChangedAt ?? (() => recordMtime(deps.dataDir)))(),
  })
  return decision.apply ? start(deps, decision.version, state.checkedAt) : decision.reason
}

const errorLabel = (error: unknown): string => (error instanceof Error ? error.name : 'error')

/** One look at the saved state; returns what it did or why it held back. Never throws. */
export function runAutoUpdateTick(deps: AutoUpdateDeps, since: number = 0): AutoUpdateHold | 'started' | 'failed' {
  try {
    return tickOnce(deps, since)
  } catch (error: unknown) {
    deps.log(`auto-update failed (${errorLabel(error)})`)
    return 'failed'
  }
}

/** After a tick that threw, how long the next ones are skipped. */
export const ERROR_BACKOFF_MS = 3_600_000

/**
 * The tick the daemon runs every minute. A tick that throws (the state file
 * cannot be written, say) is logged once and then left alone for an hour: a
 * line a minute would bury the log, and the same error is not logged again
 * when it comes back. `since` is when this daemon began; see stillBlocked.
 */
export function createAutoUpdateTicker(deps: AutoUpdateDeps, since?: number): () => AutoUpdateHold | 'started' | 'failed' | 'paused' {
  const clock = (): number => {
    try {
      return deps.now()
    } catch {
      return Date.now()
    }
  }
  const began = since ?? clock()
  let pausedUntil = 0
  let logged: string | null = null
  return () => {
    if (clock() < pausedUntil) return 'paused'
    try {
      const result = tickOnce(deps, began)
      logged = null
      return result
    } catch (error: unknown) {
      const label = errorLabel(error)
      if (label !== logged) deps.log(`auto-update failed (${label}); trying again in an hour`)
      logged = label
      pausedUntil = clock() + ERROR_BACKOFF_MS
      return 'failed'
    }
  }
}

export function startAutoUpdates(deps: AutoUpdateDeps, tickMs: number = AUTO_TICK_MS): { stop(): void } {
  const tick = createAutoUpdateTicker(deps)
  const timer = setInterval(tick, tickMs)
  return { stop: () => clearInterval(timer) }
}

/** What `kinfold status` and the dashboard show beside the switch. */
export interface AutoUpdateView {
  on: boolean
  /** Why it is off; null when on. */
  reason: string | null
  /** The last failed attempt, while the release it was for is still newer than the running one. */
  lastError: AutoUpdateState['failure']
  lastUpdate: AutoUpdateState['updated']
}

export const NO_RESULT = 'the updater started and recorded no result; see logs/auto-update.log'

export function autoUpdateView(dataDir: string, running: string, env: Env, now: number = Date.now()): AutoUpdateView {
  const setting = autoUpdateSetting(running, readInstallRecord(dataDir), env)
  const auto = readAutoState(dataDir)
  // A failure for a release that was since installed, by hand or by a later run, is no longer a problem to show.
  const stillOwed = auto.failure !== null && parseVersion(auto.failure.version) !== null && parseVersion(running) !== null && compareVersions(auto.failure.version, running) > 0
  // An updater that was killed, or never started, writes nothing; its silence is the error to show.
  const lost = lostAttempt(auto, now)
  const lostOwed = lost !== null && parseVersion(lost.version) !== null && parseVersion(running) !== null && compareVersions(lost.version, running) > 0
  const lastError = stillOwed ? auto.failure : lostOwed && lost !== null ? { version: lost.version, at: lost.startedAt, reason: NO_RESULT } : null
  return { on: setting.on, reason: setting.on ? null : setting.reason, lastError, lastUpdate: auto.updated }
}
