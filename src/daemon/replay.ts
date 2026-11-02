// Scheduler replay: feeds a stored event timeline through the real
// observer scheduler on a virtual clock, with a fake runner that takes the
// stored run durations of the same host in order. No model is called and no
// payload is read. A temp store with the real schema holds the events, so
// queueStats, retryableEvents and the idle-session rule behave as in the
// daemon. Every run succeeds; failures and their retries are not replayed.
// The clock advances to the next ingest, run finish or 5 s tick, as the
// daemon ticks the observer after each drain and on its interval.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BatchOutcome, MAX_BATCH_EVENTS } from '../observer/process'
import type { Database } from '../sqlite/types'
import { openStore } from '../store/db'
import { markDone, markProcessing, retryableEvents } from '../store/observer-store'
import type { TimelineEvent } from '../store/replay-reads'
import { DEFAULT_OBSERVER_TICK_MS, type DueReason, type ObserverScheduleConfig, createObserverScheduler } from './observer-scheduler'

export interface ReplayRun {
  sessionId: number
  host: string
  reason: DueReason
  startedAt: number
  finishedAt: number
  eventIds: string[]
}

export interface ReplayOptions {
  config?: Partial<ObserverScheduleConfig>
  tickMs?: number
  /** Used when a host has no stored run. */
  fallbackDurationMs?: number
}

type Durations = ReadonlyMap<string, readonly number[]>

const NOT_CITABLE: ReadonlySet<string> = new Set(['session_start', 'session_end'])
const DEFAULT_FALLBACK_MS = 10_000

interface Completion {
  at: number
  finish: () => void
}

/** Cycles through each host's stored durations, oldest first. */
function durationPicker(durations: Durations, fallback: number): (host: string) => number {
  const next = new Map<string, number>()
  return (host) => {
    const list = durations.get(host) ?? []
    if (list.length === 0) return fallback
    const index = next.get(host) ?? 0
    next.set(host, index + 1)
    return list[index % list.length] ?? fallback
  }
}

function ingest(db: Database, event: TimelineEvent): void {
  db.query(
    `INSERT INTO sessions (id, host, host_session_id, project_key, cwd, started_at, last_event_at)
     VALUES ($id, $host, $hsid, 'replay', '/replay', $at, $at)
     ON CONFLICT (id) DO UPDATE SET last_event_at = max(last_event_at, excluded.last_event_at)`,
  ).run({ id: event.sessionId, host: event.host, hsid: String(event.sessionId), at: event.occurredAt })
  db.query(
    `INSERT INTO events (event_id, session_id, prompt_number, kind, content_hash, occurred_at, ingested_at)
     VALUES ($eventId, $sessionId, $promptNumber, $kind, $eventId, $occurredAt, $ingestedAt)`,
  ).run({ eventId: event.eventId, sessionId: event.sessionId, promptNumber: event.promptNumber, kind: event.kind, occurredAt: event.occurredAt, ingestedAt: event.ingestedAt })
  if (event.kind === 'session_end') db.query('UPDATE sessions SET ended_at = $at WHERE id = $id').run({ id: event.sessionId, at: event.occurredAt })
}

function unfinished(db: Database): boolean {
  return db.query("SELECT 1 FROM events WHERE observer_state IN ('pending', 'processing') LIMIT 1").get() !== null
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Replays `timeline` (ingest order) and returns every run the scheduler started, in finish order. */
export async function runReplay(timeline: readonly TimelineEvent[], durations: Durations, options: ReplayOptions = {}): Promise<ReplayRun[]> {
  const root = mkdtempSync(join(tmpdir(), 'sam-replay-'))
  const store = openStore(join(root, 'data'))
  try {
    store.db.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('replay', 'path', 'replay', 0)")
    return await simulate(store.db, timeline, durations, options)
  } finally {
    store.db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

/** The virtual clock and what is in flight; one per replay. */
interface SimState {
  clock: number
  completions: Completion[]
  runs: ReplayRun[]
  reasons: Map<number, DueReason>
}

/** Mirrors processSessionBatch: oldest 50 retryable events, no call for start/end only; finishes when the clock gets there. */
function fakeProcessor(db: Database, sim: SimState, hostOf: ReadonlyMap<number, string>, pick: (host: string) => number): (sessionId: number) => Promise<BatchOutcome> {
  return (sessionId) => {
    const batch = retryableEvents(db, sessionId, sim.clock, MAX_BATCH_EVENTS)
    if (batch.length === 0) return Promise.resolve({ status: 'idle' })
    const eventIds = batch.map((event) => event.eventId)
    if (batch.every((event) => NOT_CITABLE.has(event.kind))) {
      markDone(db, eventIds)
      return Promise.resolve({ status: 'skipped', events: eventIds.length })
    }
    markProcessing(db, eventIds)
    const host = hostOf.get(sessionId) ?? 'unknown'
    const run: ReplayRun = { sessionId, host, reason: sim.reasons.get(sessionId) ?? 'boundary', startedAt: sim.clock, finishedAt: sim.clock + pick(host), eventIds }
    return new Promise((resolve) => {
      const finish = (): void => {
        markDone(db, eventIds)
        sim.runs.push(run)
        resolve({ status: 'succeeded', runId: sim.runs.length, events: eventIds.length, echoes: 0, droppedRelations: 0, observations: 0, inserted: 0, downgraded: 0, summary: false, links: 0, contradicted: 0 })
      }
      sim.completions = [...sim.completions, { at: run.finishedAt, finish }].sort((a, b) => a.at - b.at)
    })
  }
}

async function simulate(db: Database, timeline: readonly TimelineEvent[], durations: Durations, options: ReplayOptions): Promise<ReplayRun[]> {
  const sim: SimState = { clock: timeline[0]?.ingestedAt ?? 0, completions: [], runs: [], reasons: new Map() }
  const hostOf = new Map(timeline.map((event) => [event.sessionId, event.host]))
  const processSession = fakeProcessor(db, sim, hostOf, durationPicker(durations, options.fallbackDurationMs ?? DEFAULT_FALLBACK_MS))
  const scheduler = createObserverScheduler({
    db, processSession, now: () => sim.clock, config: options.config ?? {}, onStart: (sessionId, reason) => sim.reasons.set(sessionId, reason),
  })
  const tickMs = options.tickMs ?? DEFAULT_OBSERVER_TICK_MS
  let index = 0
  let nextTick = sim.clock
  while (index < timeline.length || sim.completions.length > 0 || unfinished(db)) {
    const nextIngest = timeline[index]?.ingestedAt ?? Number.POSITIVE_INFINITY
    const nextDone = sim.completions[0]?.at ?? Number.POSITIVE_INFINITY
    sim.clock = Math.min(nextIngest, nextDone, nextTick)
    if (nextDone === sim.clock) {
      const [first, ...rest] = sim.completions
      sim.completions = rest
      first?.finish()
    } else if (nextIngest === sim.clock) {
      while (timeline[index]?.ingestedAt === sim.clock) ingest(db, timeline[index++] as TimelineEvent)
      scheduler.tick()
    } else {
      scheduler.tick()
      nextTick += tickMs
    }
    await flush()
  }
  scheduler.stop()
  return sim.runs
}
