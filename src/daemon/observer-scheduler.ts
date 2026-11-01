// Decides when a session's events go to the observer, and caps concurrency:
// one call in flight per session, at most two overall, so three busy tools
// never fan out into a burst of model calls. A session is due when its turn
// ended (turn_end or session_end waiting), when enough events piled up, when
// it went quiet, or when it ended. A session silent for KINFOLD_SESSION_IDLE_MS
// with no ended_at is ended here, because OpenCode never says so on quit.
// P1-E: a long turn's early events used to wait for the whole turn (or for 8
// more events). Now a session is also due once its oldest pending event has
// waited maxWaitMs, but at most maxEarlyRunsPerTurn times between two turn
// boundaries, so a long turn costs a bounded number of extra observer runs.
// An ended session that gets new events is live again: the old rule made each
// of those events its own run (replay: 257 of 511 runs).

import { envName } from '../env-names'
import type { BatchOutcome } from '../observer/process'
import type { Database } from '../sqlite/types'
import { type QueueStats, endIdleSessions, queueStats } from '../store/observer-store'
import { oldestPendingIngest } from '../store/schedule-reads'

export interface ObserverScheduleConfig {
  maxGlobal: number
  batchAtEvents: number
  quietMs: number
  sessionIdleMs: number
  /** A pending event that waited this long since ingest makes its session due mid-turn. */
  maxWaitMs: number
  /** 'waited' starts allowed per session between two turn-closing starts. */
  maxEarlyRunsPerTurn: number
  /** Events after ended_at make a session live again. false is the pre-P1-E rule, kept for the replay's baseline. */
  resumeAfterEnd: boolean
}

export const DEFAULT_SCHEDULE: ObserverScheduleConfig = {
  maxGlobal: 2,
  batchAtEvents: 8,
  quietMs: 60_000,
  sessionIdleMs: 30 * 60_000,
  // Chosen on a replay of the live timeline (docs/p1e-report.md): shorter
  // waits put a run in flight when the turn ends and raise turn-end p95.
  maxWaitMs: 75_000,
  maxEarlyRunsPerTurn: 2,
  resumeAfterEnd: true,
}

/** The scheduler before P1-E: no mid-turn wait rule, and any ended_at made a session due. */
export const LEGACY_SCHEDULE: ObserverScheduleConfig = { ...DEFAULT_SCHEDULE, maxEarlyRunsPerTurn: 0, resumeAfterEnd: false }

/** Why a session is due, in the order checked. Only 'count' and 'waited' happen mid-turn. */
export type DueReason = 'boundary' | 'ended' | 'count' | 'quiet' | 'waited'

export interface ScheduleStats extends QueueStats {
  /** ingested_at of the oldest pending event; absent or null when none is pending. */
  oldestPendingAt?: number | null
}

/** Starts with these reasons close a turn and reset the session's early-run count. */
const TURN_CLOSERS: ReadonlySet<DueReason> = new Set(['boundary', 'ended', 'quiet'])

export const DEFAULT_OBSERVER_TICK_MS = 5_000

export interface ObserverSchedulerOptions {
  db: Database
  processSession: (sessionId: number) => Promise<BatchOutcome>
  config?: Partial<ObserverScheduleConfig>
  now?: () => number
  log?: (line: string) => void
  /** Called before each start with its trigger; the replay uses it to attribute runs. */
  onStart?: (sessionId: number, reason: DueReason) => void
}

export interface ObserverScheduler {
  /** Ends idle sessions, then starts every due session the caps allow. Never blocks. */
  tick(): void
  /** Resolves once no observer call is in flight. */
  whenIdle(): Promise<void>
  inFlight(): number[]
  /** Starts no new calls; in-flight ones finish on their own. */
  stop(): void
}

/** `earlyRuns` is how many 'waited' starts the session had since its last turn-closing start. */
export function dueReason(stats: ScheduleStats, now: number, config: ObserverScheduleConfig, earlyRuns: number = 0): DueReason | null {
  if (stats.hasBoundary) return 'boundary'
  // A session that got events after its end (resumed, or ended by the idle
  // rule) is live again; treating it as ended made every new event its own run.
  if (stats.endedAt !== null && (!config.resumeAfterEnd || stats.lastEventAt <= stats.endedAt)) return 'ended'
  if (stats.retryable >= config.batchAtEvents) return 'count'
  if (now - stats.lastEventAt >= config.quietMs) return 'quiet'
  const oldest = stats.oldestPendingAt ?? null
  if (oldest !== null && now - oldest >= config.maxWaitMs && earlyRuns < config.maxEarlyRunsPerTurn) return 'waited'
  return null
}

export function shouldObserve(stats: ScheduleStats, now: number, config: ObserverScheduleConfig): boolean {
  return dueReason(stats, now, config) !== null
}

function parsePositiveMs(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const ms = Number(value)
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error(`${name} must be a positive integer`)
  return ms
}

export function parseIdleMs(value: string | undefined): number {
  return parsePositiveMs(envName('SESSION_IDLE_MS'), value, DEFAULT_SCHEDULE.sessionIdleMs)
}

/** KINFOLD_OBSERVER_MAX_WAIT_MS: how long a pending event may wait mid-turn before its session is due. */
export function parseMaxWaitMs(value: string | undefined): number {
  return parsePositiveMs(envName('OBSERVER_MAX_WAIT_MS'), value, DEFAULT_SCHEDULE.maxWaitMs)
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error'
}

/** Promises that resolve the next time the in-flight set is empty. */
function idleWaiters(running: ReadonlySet<number>): { settle: () => void; wait: () => Promise<void> } {
  let waiters: (() => void)[] = []
  return {
    settle: () => {
      if (running.size > 0) return
      const pending = waiters
      waiters = []
      for (const resolve of pending) resolve()
    },
    wait: () => (running.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve))),
  }
}

export function createObserverScheduler(options: ObserverSchedulerOptions): ObserverScheduler {
  const config: ObserverScheduleConfig = { ...DEFAULT_SCHEDULE, ...options.config }
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const running = new Set<number>()
  const idle = idleWaiters(running)
  /** sessionId -> 'waited' starts since its last turn-closing start. In memory: a restart grants a fresh allowance. */
  let earlyRuns: ReadonlyMap<number, number> = new Map()
  let stopped = false

  const count = (sessionId: number, reason: DueReason): void => {
    const next = new Map(earlyRuns)
    if (TURN_CLOSERS.has(reason)) next.delete(sessionId)
    else if (reason === 'waited') next.set(sessionId, (earlyRuns.get(sessionId) ?? 0) + 1)
    earlyRuns = next
  }

  const start = (sessionId: number, reason: DueReason): void => {
    count(sessionId, reason)
    options.onStart?.(sessionId, reason)
    running.add(sessionId)
    options.processSession(sessionId).then(
      (outcome) => finish(sessionId, outcome.status === 'succeeded'),
      (error: unknown) => {
        log(`observer session=${sessionId} crashed error=${errorName(error)}`)
        finish(sessionId, false)
      },
    )
  }

  /** Only a success re-ticks at once: a failed batch waits for its retry time, a disabled host for the next tick. */
  const finish = (sessionId: number, again: boolean): void => {
    running.delete(sessionId)
    if (again && !stopped) tick()
    idle.settle()
  }

  const tick = (): void => {
    if (stopped) return
    const at = now()
    const ended = endIdleSessions(options.db, at - config.sessionIdleMs)
    if (ended.length > 0) log(`observer ended idle sessions=${ended.join(',')}`)
    const oldest = oldestPendingIngest(options.db)
    for (const stats of queueStats(options.db, at)) {
      if (running.size >= config.maxGlobal) break
      if (running.has(stats.sessionId)) continue
      const reason = dueReason({ ...stats, oldestPendingAt: oldest.get(stats.sessionId) ?? null }, at, config, earlyRuns.get(stats.sessionId) ?? 0)
      if (reason !== null) start(stats.sessionId, reason)
    }
  }

  return {
    tick,
    whenIdle: idle.wait,
    inFlight: () => [...running],
    stop: () => {
      stopped = true
    },
  }
}
