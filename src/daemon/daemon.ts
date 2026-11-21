// Wires the store, the drain and the HTTP server into one process (the only
// writer). Drains on start, on every nudge, and on a fallback interval
// so an event whose nudge was lost still lands within a couple of seconds.
// With observer options it also runs the observer scheduler, rebuilds
// a project's context packs after each observer write, and checks whether
// failed events can be retried. It serves packs on POST /context,
// and observer settings on GET/PUT /observer/settings (the installer
// and later the dashboard). Data control adds the /data routes and two
// background ticks: the leak scanner and retention. The web dashboard
// is served by the same server: login codes and sessions live in memory,
// and it reads through /memory, /metrics/summary and POST /observer/test,
// which uses the observer's own RunnerFactory. It times every injection
// (context-route.ts) and takes the MCP server's read reports on
// POST /metrics/mcp-read (mcp-read-route.ts), so hit rate can be measured.
// Marker and fingerprint keys come from hmac-rotation.ts (Keychain
// master read once at start, per-epoch sub-key files rotated on a tick).
// With vector options it loads sqlite-vec into its connection, embeds
// observations in the background (after each observer write and on a tick)
// and answers POST /search/semantic for the MCP server's hybrid search.
//
// The process has two layers. The shell is the HTTP server, the dashboard
// sessions, the token and the HMAC keys: it lives as long as the process. The
// core is everything that holds memory.db: the writer, the reader, the vector
// worker, the drain, the observer and the data ticks. A restore stops the
// core, swaps the store, and starts a new core on it, so the port, the
// sessions and the page a person is watching all survive
// (backup-routes.ts). While there is no core, store routes answer 503.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { envName, readEnv } from '../env-names'
import { type DbKeyStore, dbKeyStoreFor, rememberedDbKeys } from '../sqlite/keys'
import { plaintextBesideKey } from '../sqlite/open'
import type { Database } from '../sqlite/types'
import { writeFileAtomic } from '../fs/atomic'
import { DAEMON_INFO_FILE, DATA_FILE_MODE, SPOOL_DIR, TOKEN_FILE, ensureDataDir, newSecret, writePrivateFile } from '../store/data-dir'
import { type Store, openStore } from '../store/db'
import { type AsyncGitRunner, DAEMON_GIT_TIMEOUT_MS, asyncGitRunnerWithTimeout, createProjectKeyResolver, gitRunnerWithTimeout, rootCommitOfAsync } from '../store/project-key'
import { backfillRoots, unrootedFolders } from '../store/project-merge'
import { projectRoute } from './project-routes'
import { listRecentSessions } from '../store/reads'
import { rebuildProjectPacks } from '../context/packs'
import { clearBackoff, ensureBackoffIndex } from '../observer/backoff'
import { type BatchOutcome, processSessionBatch } from '../observer/process'
import type { RunnerFactory } from '../observer/runners'
import type { CliObserverRunner } from '../observer/runners/cli-core'
import type { ObserverSettings } from '../observer/types'
import type { SafetyGate } from '../observer/safety-gate'
import { type CredentialProvider, NO_CREDENTIALS } from '../secrets/credentials'
import { getObserverSession, recoverInterrupted } from '../store/observer-store'
import { type RetryTarget, resetFailedEvents } from '../store/observer-reset'
import { DEFAULT_RESET_CHECK_MS, checkFailedResets } from './failed-reset'
import { type HmacKeyState, ROTATION_TICK_MS, createHmacKeys } from './hmac-rotation'
import { createSpoolCursor } from '../spool/spool'
import { type DrainOptions, type DrainResult, drainBatch } from './ingest'
import { logLine } from './log-line'
import { DEFAULT_OBSERVER_TICK_MS, type ObserverScheduleConfig, type ObserverScheduler, createObserverScheduler } from './observer-scheduler'
import { type DrainScheduler, createDrainScheduler } from './scheduler'
import { createDashboardAuth, fileSessionStore } from '../dashboard/auth'
import { createDashboardEvents } from '../dashboard/events'
import { keptMetricsRoute } from '../dashboard/metrics'
import { writeDisplayFile } from '../context/display-file'
import { watchRoute } from '../watch/reads'
import { type TurnEnd, type TurnUsage, freshTurnEnds, recordTurnUsage } from './transcript-usage'
import { createTraceBuffer, type TraceBuffer } from '../debug/trace'
import { debugWatchRoute, observerTrace, turnTrace } from './debug-trace'
import { sessionRoute } from './session-routes'
import { countEmbeddingCall } from '../store/impact-reads'
import { type DisplaySettings, readDisplaySettings } from '../store/display-settings'
import { HOLDOUT_HOSTS, contextHandler } from './context-route'
import { dataHandlers } from './data-routes'
import { mcpReadHandler } from './mcp-read-route'
import { memoryHandlers } from './memory-routes'
import { listDevices } from '../central/devices'
import { type ActivityInput, type ActivityRing, createActivityRing, recordActivity, recordUpdateOnce } from '../store/activity-store'
import { readAutoState } from '../update/auto-state'
import { observerModelsRoute } from './observer-models-route'
import { createObserverTester, observerTestRoute } from './observer-test'
import { startDataTicks } from './data-ticks'
import { VERSION } from '../version'
import { type UpdateCheckDeps, startUpdateChecks } from '../update/check'
import { type AutoUpdateDeps, autoUpdateView, startAutoUpdates } from '../update/auto'
import { startStaging } from '../update/stage'
import { updateRouteHandlers } from './update-routes'
import { bannerNotice, userMessage } from '../update/notice'
import { setAutoUpdate } from '../install/setup/record'
import { type OsName, currentPlatform } from '../platform/platform'
import { LOOPBACK_HOST, MAX_UPLOAD_BYTES, type ServerDeps, handleRequest, startServer } from './server'
import { type CentralStatus, centralStatus, deviceEndpoint, hubCore } from '../central/daemon-central'
import { type HubDaemon, startHubWhenReady } from '../central/hub-daemon'
import type { CentralCore } from '../central/hub-routes'
import { type CentralMode, centralModeOf } from '../central/mode'
import { type Relay, createRelay } from '../central/relay'
import { type Tailscale, systemTailscale } from '../central/tailscale'
import { noticeField, updateNoticeFor } from './context-route'
import { type BackupRoutes, backupRoutes, uploadLimitFor } from './backup-routes'
import { snapshotInWorker, snapshotInto } from '../backup/snapshot'
import type { KeyStore } from '../secrets/key-store'
import { keyStoresOffForTests, processKeyStoreDeps, resolveKeyStore } from '../secrets/key-store-record'
import type { ReadRouteDeps } from './read-routes'
import { type MemoryReader, openMemoryReader } from '../mcp/reader'
import { MCP_SEMANTIC_TIMEOUT_MS, type SemanticClient } from '../mcp/semantic-client'
import { keyStoreToken, settingsHandlers } from './settings-route'
import type { Embedder } from '../vectors/embedder'
import { type EmbedderSet, NO_OPENROUTER_KEY } from '../vectors/embedders'
import { probeLocalLlmDims } from '../vectors/local-llm-embedder'
import { embeddingSettingsRoute } from './embedding-route'
import { type Support, loadVec0 } from '../vectors/extension'
import { DEFAULT_INDEX_TICK_MS, type VectorIndexer, createVectorIndexer } from '../vectors/indexer'
import { createUpkeepTurns } from '../vectors/upkeep-turn'
import { type SemanticAnswer, type SemanticRequest, createSemanticSearch } from '../vectors/search'
import { createRestarter } from './restart'
import { type StallWatch, createStallWatch } from './stall-watch'
import { type Exclusive, type VectorQueries, inlineVectorQueries, startVectorWorker, workerOrInline } from '../vectors/vector-worker'
import { type StoreReader, inlineStoreReader, readerOrInline, startStoreReader } from '../workers/store-reader'
import { type Checkpointer, WAL_TRUNCATE_BYTES, startCheckpointer } from '../workers/checkpointer'
import { type SpaceManager, createSpaceManager } from '../vectors/space-manager'
import { LOCAL_MODEL_ID } from '../vectors/local-model'

export const DEFAULT_PORT = 37_811
export const FALLBACK_DRAIN_MS = 2_000

export interface DaemonOptions {
  dataDir: string
  /** 0 picks a free port; the chosen one is written to daemon.json. */
  port: number
  /** The program version /health reports. main.ts passes VERSION; tests inject a release one. */
  version?: string
  fallbackDrainMs?: number
  debounceMs?: number
  log?: (line: string) => void
  /** Without this the daemon only ingests: tests and tools that must never call a model leave it out. */
  observer?: DaemonObserverOptions
  /** Leak-scan and retention tick intervals; the /data routes are always on. */
  dataControl?: { scanTickMs?: number; retentionTickMs?: number }
  /** Where the HMAC master is read from, once at start; main.ts passes the macOS Keychain. Default none: hmac.key as before key rotation. */
  keychain?: CredentialProvider
  /** The database key store; default this platform's (src/sqlite/keys.ts). */
  dbKeys?: DbKeyStore
  /** The dashboard leases' and log's clock, for tests. */
  dashboard?: { now?: () => number }
  /** Rotation tick and clock, for tests. */
  hmac?: { rotationTickMs?: number; now?: () => number }
  /** Semantic search. Without it there is no embedding and /search/semantic answers unavailable. */
  vectors?: DaemonVectorOptions
  /** The daily update check's fetch, clock and environment, for tests. It never runs for a 0.0.0-dev version. */
  updateCheck?: Partial<Pick<UpdateCheckDeps, 'fetch' | 'now' | 'envVars'>>
  /**
   * Set only when this daemon is the installed program: patch releases are
   * then applied by starting that program's `update --auto` detached. Absent
   * (a checkout, a copy run from elsewhere, the tests) nothing is ever started.
   */
  autoUpdate?: { program: string; os: OsName; tickMs?: number; platform?: NodeJS.Platform; arch?: string } & Pick<AutoUpdateDeps, 'spawn' | 'exists'>
  /** Where a restored store's key is written; null: none. Default: the store key-store.json names, read when a restore needs it. */
  keyStore?: KeyStore | null
  /** Test seams for the backup and restore routes. */
  backup?: DaemonBackupOptions
  /** Central memory: the mode (default: install.json's) and, for tests, the Tailscale lookups and a loopback hub listener. */
  central?: DaemonCentralOptions
}

export interface DaemonCentralOptions {
  /** Overrides install.json; null is local. */
  mode?: CentralMode | null
  tailscale?: Tailscale
  /** Tests only: the hub listener may bind loopback, standing in for the tailnet. */
  allowLoopback?: boolean
  hubRetryMs?: number
}

export interface DaemonBackupOptions {
  /** The most a restore upload may be; default the hard ceiling, lowered to what the disk can hold. */
  uploadLimit?: () => number
  /** The wait between tries while another process holds memory.db. */
  sleep?: (ms: number) => Promise<void>
  lockAttempts?: number
  /** The store could not be opened again after a restore; default logs and ends the process, so the service starts a fresh one. */
  onFatal?: (reason: string) => void
}

export interface DaemonVectorOptions {
  /** The embedder of the configured space; null: none, so nothing is embedded. Tests pass this. */
  embedder?: Embedder | null
  /** Built from the store's embedding settings at each core start (main.ts); wins over embedder. */
  embedders?: (db: Database) => EmbedderSet
  tickMs?: number
}

interface Vectors {
  indexer: VectorIndexer | null
  support: Support
  search: (request: SemanticRequest) => Promise<SemanticAnswer>
  timer: Timer | null
  /** Ends upkeep before the store closes: the running turn finishes its slice, and none runs again. */
  stopUpkeep: () => Promise<void>
  /** Closed on stop: ends the search worker when there is one. */
  queries: VectorQueries
  spaces: SpaceManager
  close: () => Promise<void>
}

const VECTORS_OFF: Support = { ok: false, reason: 'semantic search is not configured in this daemon' }
/** The local model runs on this machine's CPU: two batches of 32 per tick keep it to a fraction of one core. */
export const LOCAL_BATCHES_PER_TICK = 2

/**
 * The same embedder, with each call it makes counted for the Metrics page.
 * The indexer and the search share it, so one place counts both; a call is
 * counted when it is made, since one that times out was still sent. A count
 * that cannot be written never stops an embedding.
 */
export function countedEmbedder(db: Database, embedder: Embedder, log: (line: string) => void): Embedder {
  return {
    model: embedder.model,
    dims: embedder.dims,
    embed: (texts, signal, purpose) => {
      try {
        countEmbeddingCall(db, texts.length, Date.now())
      } catch (error: unknown) {
        log(`embedding call not counted: ${error instanceof Error ? error.name : 'error'}`)
      }
      return embedder.embed(texts, signal, purpose)
    },
  }
}

/** The embedder whose space search reads now, or why there is none. */
function searchEmbedder(spaces: SpaceManager, embedders: readonly Embedder[], reason: string): { embedder: Embedder | null; reason: string } {
  const space = spaces.searchSpace()
  if (space === null) return { embedder: null, reason: embedders.length === 0 ? reason : 'no embedding space yet' }
  const embedder = embedders.find((candidate) => candidate.model === space.model && candidate.dims === space.dims) ?? null
  return { embedder, reason: embedder === null ? `the embedder for ${space.model} is not available; search returns once the new space is built` : '' }
}

/**
 * Loads sqlite-vec, keeps the embedding spaces and their vec0 indexes, starts
 * the indexer when there is an embedder, and builds the search. Indexing works
 * without the extension. The nearest-vector reads run in a worker on its own
 * read-only connection, so a slow search never holds the thread that answers
 * /health and hooks.
 */
function startVectors(store: Store, dataDir: string, dbKeys: DbKeyStore, options: DaemonVectorOptions | undefined, log: (line: string) => void, watch: StallWatch): Vectors {
  const db = store.db
  const support = options === undefined ? VECTORS_OFF : loadVec0(db, dataDir)
  const set: EmbedderSet = options?.embedders?.(db) ?? { target: options?.embedder ?? null, others: [], reason: NO_OPENROUTER_KEY }
  const embedder = set.target === null ? null : countedEmbedder(db, set.target, log)
  const all = [...(embedder === null ? [] : [embedder]), ...set.others.map((other) => countedEmbedder(db, other, log))]
  log(`vectors search=${support.ok ? `on (${support.detail})` : `off (${support.reason})`} embedder=${embedder === null ? `none (${set.reason})` : embedder.model}`)
  const spaces = createSpaceManager({
    db, vec0: support.ok, target: embedder === null ? null : { model: embedder.model, dims: embedder.dims }, now: Date.now, log,
    step: (label, fn) => watch.step(`vectors upkeep: ${label}`, fn),
  })
  const upkeepFailed = (error: unknown): void => log(`vectors upkeep failed (${error instanceof Error ? error.message.slice(0, 120) : 'error'})`)
  // Each slice is timed on its own, so the watch names a slow one; between slices the thread answers requests.
  const upkeep = createUpkeepTurns({ slice: () => watch.step('vectors upkeep', () => spaces.step()), onError: upkeepFailed })
  // The first slice runs now, so the active space exists before the first search.
  try {
    watch.step('vectors upkeep', () => spaces.step())
  } catch (error: unknown) {
    upkeepFailed(error)
  }
  const inline = inlineVectorQueries(db)
  const queries = support.ok && all.length > 0
    ? workerOrInline(startVectorWorker({
      dbPath: store.path, dataDir, key: dbKeys.read(), libraryOverride: readEnv(process.env, 'SQLITE3MC_LIB') ?? null, cacheKib: DAEMON_CACHE_KIB,
    }), inline, log)
    : inline
  const indexer = embedder === null ? null : createVectorIndexer({
    db, embedder, log, onWritten: (rows) => spaces.written(rows),
    ...(embedder.model === LOCAL_MODEL_ID ? { maxBatchesPerTick: LOCAL_BATCHES_PER_TICK } : {}),
  })
  const timer = indexer === null && all.length === 0 ? null : setInterval(() => {
    void upkeep.run().then(() => watch.step('vectors indexer turn', () => indexer?.tick()))
  }, options?.tickMs ?? DEFAULT_INDEX_TICK_MS)
  watch.step('vectors indexer turn', () => indexer?.tick())
  const search = createSemanticSearch({ db, embedder, embedderFor: () => searchEmbedder(spaces, all, set.reason), support, queries })
  return { indexer, support, search, timer, stopUpkeep: () => upkeep.stop(), queries, spaces, close: async () => set.close?.() }
}

/** A central device's vectors: none searched, none written, and the store's spaces left as they are for the day it leaves. */
function deviceVectors(db: Database): Vectors {
  return {
    indexer: null,
    support: VECTORS_OFF,
    search: async () => ({ status: 'unavailable', reason: 'this device uses central memory; the hub searches it' }),
    timer: null,
    stopUpkeep: async () => {},
    queries: inlineVectorQueries(db),
    spaces: { step: () => false, searchSpace: () => null, written: () => {}, status: () => ({ active: null, building: null }) },
    close: async () => {},
  }
}

export interface DaemonObserverOptions {
  runnerFor: RunnerFactory
  /** Builds a CLI login runner, for listing the installed CLI's models. Without it /observer/models answers 503. */
  cliRunnerFor?: (settings: ObserverSettings) => CliObserverRunner
  /** Builds the safety gate for CLI login observers on the daemon's own database. */
  safety?: (db: Database, log: (line: string) => void) => SafetyGate
  tickMs?: number
  schedule?: Partial<ObserverScheduleConfig>
  /** Read only to fingerprint provider keys for the failed-event reset; defaults to none. */
  credentials?: CredentialProvider
  resetCheckMs?: number
}

interface Observing {
  observer: ObserverScheduler
  timers: Timer[]
  safety: SafetyGate | undefined
}

export interface DaemonInfo {
  pid: number
  port: number
}

export interface RunningDaemon {
  port: number
  dataDir: string
  /** The drain, observer and indexer of the store that is open now; a restore replaces all three. */
  readonly scheduler: DrainScheduler
  readonly observer: ObserverScheduler | null
  hmacKeys: HmacKeyState
  /** Null without an embedder. */
  readonly vectors: VectorIndexer | null
  /** The hub listener on a hub, the relay on a central device; both null when local. */
  central: { hub: HubDaemon | null; relay: Relay | null; status: () => CentralStatus }
  /** Settles once the store readers the core starts with have opened memory.db: after it, the daemon touches the files only to serve and write. */
  readersStarted: () => Promise<void>
  stop: () => Promise<void>
}

/** The routes that read or write memory.db; a restore swaps them for the new store's. */
type CoreRoutes = Pick<ServerDeps, 'schemaVersion' | 'vectorSearch' | 'semanticSearch' | 'onNudge' | 'listSessions' | 'context' | 'retryFailed' | 'observerSettings' | 'data' | 'exclusive' | 'memory' | 'metrics' | 'projects' | 'watch' | 'debugWatch' | 'sessions' | 'mcpRead' | 'reads' | 'embeddingSettings'>

/** Everything that holds memory.db open. */
interface Core {
  routes: CoreRoutes
  /** What paired devices may ask of this store; null unless this daemon is a hub. */
  central: CentralCore | null
  scheduler: DrainScheduler
  observer: ObserverScheduler | null
  indexer: VectorIndexer | null
  /** Writes the store's snapshot to a new file and resolves with its schema version. */
  snapshot: (dest: string) => Promise<number>
  /** A dashboard test of this provider passed. */
  passedTest: (provider: string) => void
  /** Settles once every connection to memory.db is closed. */
  stop: () => Promise<void>
  readersStarted: () => Promise<void>
  /** Logs one event for the Activity page; a central device writes nothing to its kept store. */
  activity: (input: ActivityInput) => void
}

const RESTORING = 'Kinfold is restoring a backup; try again in a moment'
/**
 * How long a daemon that must stop keeps answering first. The reason and the
 * way out (kinfold key resume) exist only in GET /restore/status, which the
 * command line and the dashboard read on a timer: several of their intervals
 * must fit, or they would report a daemon that vanished instead.
 */
export const FATAL_EXIT_MS = 5_000

function defaultKeyStore(dataDir: string): KeyStore | null {
  return keyStoresOffForTests(process.env) ? null : resolveKeyStore(dataDir, processKeyStoreDeps(dataDir))
}

export function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`${envName('PORT')} must be an integer from 0 to 65535`)
  return port
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Counts and spool file names only: quarantine reasons can quote file content. */
export function describeDrain(result: DrainResult): string | null {
  if (result.read === 0 && result.quarantined.length === 0 && result.error === undefined) return null
  const counts = `drained read=${result.read} inserted=${result.inserted} duplicates=${result.duplicates} quarantined=${result.quarantined.length}`
  const quarantined = result.quarantined.map((entry) => basename(entry.path)).join(',')
  return [counts, quarantined !== '' ? `quarantined_files=${quarantined}` : '', result.error !== undefined ? `error=${result.error}` : '']
    .filter((part) => part !== '')
    .join(' ')
}

/** After a batch that wrote rows, the session's project gets fresh packs, so the next session start reads them. */
function rebuildAfterWrite(db: Database, sessionId: number, outcome: BatchOutcome, log: (line: string) => void): void {
  if (outcome.status !== 'succeeded' || (outcome.inserted === 0 && !outcome.summary)) return
  const session = getObserverSession(db, sessionId)
  if (session === null) return
  const startedAt = Date.now()
  try {
    const packs = rebuildProjectPacks(db, session.projectKey, startedAt)
    log(`context packs rebuilt session=${sessionId} packs=${packs} ms=${Date.now() - startedAt}`)
  } catch (error: unknown) {
    log(`context pack rebuild failed session=${sessionId}: ${error instanceof Error ? error.name : 'unknown error'}`)
  }
}

/** What the observer did, for `kinfold watch --debug`; only while a debug watcher is connected, so an unwatched daemon does no extra reads. */
function traceObserver(db: Database, trace: TraceBuffer, sessionId: number, outcome: BatchOutcome, log: (line: string) => void): void {
  const at = Date.now()
  if (!trace.watching(at)) return
  try {
    const event = observerTrace(db, sessionId, outcome, at)
    if (event !== null) trace.push(event)
  } catch (error: unknown) {
    log(`trace failed: ${errorMessage(error)}`)
  }
}

/** Settings or credential changes send exhausted failed events back to pending, then the observer looks again. */
function resetCheck(db: Database, options: DaemonObserverOptions, keys: HmacKeyState, observer: ObserverScheduler, log: (line: string) => void): void {
  try {
    const outcomes = checkFailedResets({ db, credentials: options.credentials ?? NO_CREDENTIALS, fingerprintKey: keys.fingerprint(), log })
    if (outcomes.some((outcome) => outcome.events > 0)) observer.tick()
  } catch (error: unknown) {
    log(`observer reset check failed: ${errorMessage(error)}`)
  }
}

/** A passed dashboard test ends the provider's backoff, so its next batch runs without waiting out the hour. */
function passedTest(db: Database, provider: string, log: (line: string) => void): void {
  try {
    clearBackoff(db, provider, Date.now())
  } catch (error: unknown) {
    log(`observer backoff clear failed: ${errorMessage(error)}`)
  }
}

/** Recovers runs a crash left open, then ticks on an interval and after every drain that inserted rows. */
function startObserver(db: Database, options: DaemonObserverOptions, keys: HmacKeyState, afterWrite: () => void, log: (line: string) => void, trace: TraceBuffer, watch: StallWatch): Observing {
  ensureBackoffIndex(db)
  const recovered = recoverInterrupted(db, Date.now())
  if (recovered.events > 0 || recovered.runs > 0) log(`observer recovered events=${recovered.events} runs=${recovered.runs}`)
  const safety = options.safety?.(db, log)
  const observer = createObserverScheduler({
    db,
    processSession: async (sessionId) => {
      const outcome = await processSessionBatch({ db, runnerFor: options.runnerFor, log, ...(safety !== undefined ? { safety } : {}) }, sessionId)
      watch.step('observer write', () => {
        rebuildAfterWrite(db, sessionId, outcome, log)
        if (outcome.status === 'succeeded' && outcome.inserted > 0) afterWrite()
        traceObserver(db, trace, sessionId, outcome, log)
      })
      return outcome
    },
    ...(options.schedule !== undefined ? { config: options.schedule } : {}),
    log,
  })
  const check = (): void => watch.step('observer reset check', () => resetCheck(db, options, keys, observer, log))
  const tick = (): void => void watch.step('observer tick', () => observer.tick())
  const timers = [
    setInterval(tick, options.tickMs ?? DEFAULT_OBSERVER_TICK_MS),
    setInterval(check, options.resetCheckMs ?? DEFAULT_RESET_CHECK_MS),
  ]
  check()
  tick()
  return { observer, timers, safety }
}

/** In-flight calls are not awaited: a claude run can take minutes; recoverInterrupted resets them on the next start. */
function stopObserver(observing: Observing): void {
  for (const timer of observing.timers) clearInterval(timer)
  observing.observer.stop()
}

/** POST /observer/retry (the dashboard's retry action). Counts only in the log. */
function retryFailed(db: Database, target: RetryTarget, observer: ObserverScheduler | null, log: (line: string) => void): number {
  const reset = resetFailedEvents(db, target)
  log(`observer retry scope=${'sessionId' in target ? `session=${target.sessionId}` : 'all'} events=${reset}`)
  if (reset > 0) observer?.tick()
  return reset
}

interface DaemonReads {
  deps: ReadRouteDeps
  close: () => void
}

/**
 * The /read/ routes' deps. The reader is a second, read-only connection over
 * the daemon's own memory.db, opened on first use (and asked again while the
 * file cannot be opened), so it never shares the writer's statements. It
 * reads through the writer's keys, so a reopen asks no key store again.
 */
function daemonReads(dataDir: string, keys: DbKeyStore, projectKeyFor: ReadRouteDeps['projectKeyFor'], vectors: Vectors): DaemonReads {
  let reader: MemoryReader | null = null
  const semantic: SemanticClient = (query) => vectors.search({ ...query, deadlineMs: MCP_SEMANTIC_TIMEOUT_MS, giveUpMs: MCP_SEMANTIC_TIMEOUT_MS })
  return {
    deps: {
      reader: () => {
        reader ??= openMemoryReader(dataDir, keys)
        return reader
      },
      projectKeyFor,
      now: Date.now,
      ...(vectors.support.ok ? { semantic } : {}),
    },
    close: () => {
      reader?.close()
      reader = null
    },
  }
}

function removeOwnInfoFile(path: string): void {
  if (!existsSync(path)) return
  const info: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof info === 'object' && info !== null && 'pid' in info && info.pid === process.pid) rmSync(path, { force: true })
}

/**
 * Keys stored before first commits were kept get one from their latest
 * session's folder, and one repo under two keys merges (store/project-merge.ts).
 * Git runs as a child the daemon awaits, one folder at a time, and the store
 * is written once at the end: a hub with many folders or a slow disk never
 * holds the thread that answers /health and hooks. `open` says whether the
 * store is still this core's when git is done. Counts only in the log.
 */
export async function mergeSameRepos(db: Database, git: AsyncGitRunner, log: (line: string) => void, open: () => boolean = () => true): Promise<void> {
  try {
    const roots = new Map<string, string | null>()
    for (const cwd of unrootedFolders(db)) {
      if (!open()) return
      roots.set(cwd, await rootCommitOfAsync(cwd, git).catch(() => null))
    }
    if (!open() || roots.size === 0) return
    const merged = backfillRoots(db, (cwd) => roots.get(cwd) ?? null, Date.now())
    if (merged.length > 0) log(`projects merged count=${merged.length} reason=same-repo`)
  } catch (error: unknown) {
    log(`project merge check failed: ${error instanceof Error ? error.name : 'error'}`)
  }
}

/** The update auto-update.json names, once per daemon start, for a device's own activity. */
function noteDeviceUpdate(ring: ActivityRing | null, updated: { version: string; at: number } | null): void {
  if (ring === null || updated === null || ring.rows().some((row) => row.kind === 'update-installed' && row.at === updated.at)) return
  ring.push({ kind: 'update-installed', at: updated.at, detail: updated.version })
}

/** Names of the devices paired with this hub, for the dashboard's device column; none when the list cannot be read. */
function pairedDeviceNames(dataDir: string, log: (line: string) => void): ReadonlyMap<string, string> {
  try {
    return new Map(listDevices(dataDir).map((device) => [device.id, device.name]))
  } catch (error: unknown) {
    log(`device list unreadable: ${error instanceof Error ? error.name : 'error'}`)
    return new Map()
  }
}

/** The store reader workers' connections: recall reads the same hot pages a prompt does; reports read every page once in a while. */
export const RECALL_CACHE_KIB = 65_536
export const REPORTS_CACHE_KIB = 16_384
/** The delta reads a few index pages and rows per prompt. */
export const DELTA_CACHE_KIB = 4_096

export interface Readers {
  /** The prompt path's keyword and row reads (src/context/recall-reads.ts). */
  recall: StoreReader
  /** The prompt path's delta read, apart so it never waits behind a keyword read and the two are asked at once. */
  delta: StoreReader
  /** The dashboard's size, metrics, facets and browse reads, apart so a long one never queues ahead of a prompt. */
  reports: StoreReader
}

/**
 * Three store reader workers on their own read-only connections. The prompt
 * path's two start with the core (a daemon start and every store restart), so
 * the first prompt after one is not read on the daemon's connection while an
 * encrypted store opens; until one is up its reads run there. The reports
 * worker starts with its first read, and a report waits for it.
 */
function startReaders(store: Store, dataDir: string, dbKeys: DbKeyStore, log: (line: string) => void): Readers {
  const inline = inlineStoreReader(store.db, store.path)
  const start = (cacheKib: number) => () => startStoreReader({ dbPath: store.path, dataDir, key: dbKeys.read(), libraryOverride: readEnv(process.env, 'SQLITE3MC_LIB') ?? null, cacheKib })
  const warm = (reader: StoreReader): Promise<unknown> => reader.run('recallWarm', {})
  return {
    recall: readerOrInline('recall', start(RECALL_CACHE_KIB), inline, log, { eager: true, warm }),
    delta: readerOrInline('delta', start(DELTA_CACHE_KIB), inline, log, { eager: true }),
    reports: readerOrInline('reports', start(REPORTS_CACHE_KIB), inline, log, { waitForStart: true }),
  }
}

interface Checkpoints {
  hold(): Promise<() => void>
  close(): Promise<void>
}

/** SQLite's own default, for a connection that checkpoints itself again. */
const DEFAULT_AUTOCHECKPOINT_PAGES = 1_000

/**
 * The checkpoint worker of one store core. Once it is up the daemon's
 * connection stops checkpointing; until then, and if it stops, that
 * connection checkpoints as SQLite does by default. A hold or a close waits
 * for a start under way, so nothing runs beside a worker that starts late.
 */
function startCheckpoints(store: Store, dbKeys: DbKeyStore, log: (line: string) => void, isOpen: () => boolean): Checkpoints {
  // A WAL that grew in a burst is cut back to this when it is reset, so a large one does not stay large.
  store.db.run(`PRAGMA journal_size_limit = ${WAL_TRUNCATE_BYTES}`)
  let worker: Checkpointer | null = null
  const selfCheckpoint = (): void => {
    if (isOpen()) store.db.run(`PRAGMA wal_autocheckpoint = ${DEFAULT_AUTOCHECKPOINT_PAGES}`)
  }
  const ready = startCheckpointer({
    dbPath: store.path, key: dbKeys.read(), libraryOverride: readEnv(process.env, 'SQLITE3MC_LIB') ?? null, log,
    onStopped: () => {
      worker = null
      selfCheckpoint()
    },
  }).then((started) => {
    if (!started.ok) return log(`checkpoint worker off (${started.reason}); the daemon connection checkpoints`)
    // Started after the core stopped: closed before the stop that waits on this goes on, so no handle outlives the store.
    if (!isOpen()) return started.checkpointer.close()
    worker = started.checkpointer
    store.db.run('PRAGMA wal_autocheckpoint = 0')
    log('checkpoint worker on; the daemon connection no longer checkpoints')
  }).catch((error: unknown) => log(`checkpoint worker off (${error instanceof Error ? error.message.slice(0, 120) : 'it failed to start'}); the daemon connection checkpoints`))
  return {
    hold: async () => {
      await ready
      return worker?.hold() ?? (() => {})
    },
    close: async () => {
      await ready
      const current = worker
      worker = null
      await current?.close()
    },
  }
}

/** A central device asks the hub for recall and reads its own kept store only for its dashboard's local pages: no workers. */
function deviceReaders(store: Store): Readers {
  const inline = inlineStoreReader(store.db, store.path)
  return { recall: inline, delta: inline, reports: inline }
}

/**
 * Purge, retention and resolve end with a TRUNCATE checkpoint, which waits
 * for every reader to leave the WAL: the vector worker's and both store
 * readers' reads are held back together while one runs, and so is the
 * checkpoint worker, since only one checkpoint can run at a time.
 */
export function exclusiveOverAll(vectors: VectorQueries, readers: Readers, holdCheckpoints: () => Promise<() => void> = async () => () => {}): Exclusive {
  return async (fn) => {
    const releases = await Promise.all([readers.recall.hold(), readers.delta.hold(), readers.reports.hold(), holdCheckpoints()])
    try {
      return await vectors.exclusive(fn)
    } finally {
      for (const release of releases) release()
    }
  }
}

/** How long after a core starts the size report is first measured: after the start's own reads, before anyone is likely to ask. */
export const SIZE_WARM_DELAY_MS = 30_000

/** The daemon's page cache, in KiB: room for the hot pages of a store of a few hundred MB. */
export const DAEMON_CACHE_KIB = 65_536

function warnIfPlaintextBesideKey(path: string, log: (line: string) => void, keys?: DbKeyStore): void {
  try {
    if (plaintextBesideKey(path, keys)) log('warning: memory.db is plaintext but the keychain holds db-key; the file was replaced or a conversion failed (see kinfold status)')
  } catch (error: unknown) {
    log(`database key check failed (${error instanceof Error ? error.name : 'error'})`)
  }
}

export function startDaemon(options: DaemonOptions): RunningDaemon {
  const dataDir = ensureDataDir(options.dataDir)
  const log = options.log ?? ((line: string) => process.stderr.write(logLine(line)))
  const version = options.version ?? VERSION
  const envVars = options.updateCheck?.envVars ?? (() => process.env)
  const updateNow = options.updateCheck?.now ?? Date.now
  const canAutoUpdate = options.autoUpdate !== undefined
  // Notices look for a staged program where this daemon stages it.
  const stagePlace = { platform: options.autoUpdate?.platform ?? currentPlatform().node, arch: options.autoUpdate?.arch ?? process.arch }
  // When anything last reached the daemon: a hook's event, a context request, an MCP read or the dashboard.
  // An update waits for a quiet spell after it. The start counts, so a daemon restarted by an update never
  // restarts again at once.
  let lastEventAt = updateNow()
  const agentEvent = (): void => {
    lastEventAt = updateNow()
  }
  // New at every start, and written only once the port is ours (below). A token that leaked while the
  // daemon was down, to whatever had taken its port, is dead as soon as the daemon is back, and a second
  // daemon that fails to bind never replaces the running one's token.
  const token = newSecret()
  const hmacKeys = createHmacKeys({ dataDir, keychain: options.keychain ?? NO_CREDENTIALS, now: options.hmac?.now ?? Date.now, log })
  // With each folder's first commit, so one repo under two keys (a renamed remote, a fork) becomes one project.
  const daemonGit = gitRunnerWithTimeout(DAEMON_GIT_TIMEOUT_MS)
  const backfillGit = asyncGitRunnerWithTimeout(DAEMON_GIT_TIMEOUT_MS)
  const projectKeyFor = createProjectKeyResolver(daemonGit, { withRoot: true })
  const mode = options.central?.mode !== undefined ? options.central.mode : centralModeOf(dataDir)
  const deviceMode = mode?.role === 'device' ? mode : null
  // A central device keeps its own store closed to writes: captures, recall and reads go to the hub.
  const relay = deviceMode === null ? null : createRelay({
    spoolDir: join(dataDir, SPOOL_DIR),
    endpoint: () => deviceEndpoint(dataDir, deviceMode, version),
    hubName: deviceMode.hubName,
    projectKeyFor,
    prepare: () => hmacKeys.marker(),
    log,
  })
  // In memory only, and kept across a core restart (a restore), so a debug watcher keeps its cursor.
  const trace = createTraceBuffer()
  // Kept across core restarts: a restart is when the store's slow work runs.
  const watch = createStallWatch({ log })

  // A device writes nothing to its kept store, so its own events (sign-ins, an update installed here) live in memory.
  const deviceActivity = relay === null ? null : createActivityRing()
  /** Bound once the restarter exists; a change saved before that has nothing to restart. */
  let applyEmbedding = (): void => {}
  function startCore(): Core {
    // One key lookup for the writer and the /read/ reader alike; a new core asks again, since a restore changes the key.
    const dbKeys = rememberedDbKeys(options.dbKeys ?? dbKeyStoreFor(dataDir))
    const store = openStore(dataDir, { keys: dbKeys })
    // Decrypted pages stay here between requests; with SQLite's 2 MB default every prompt decrypted its pages again.
    store.db.run(`PRAGMA cache_size = -${DAEMON_CACHE_KIB}`)
    warnIfPlaintextBesideKey(store.path, log, dbKeys)
    // A device's recall queries are embedded on the hub, and its own store is kept as it was: nothing here touches its vectors.
    const vectors = relay === null ? watch.step('vectors start', () => startVectors(store, dataDir, dbKeys, options.vectors, log, watch)) : deviceVectors(store.db)
    // A read waits on this lookup, as a prompt does: the key alone, never the history walk.
    const reads = daemonReads(dataDir, dbKeys, projectKeyFor.keyOnly, vectors)
    const drainOptions = (): DrainOptions => ({ spoolDir: join(dataDir, SPOOL_DIR), ...hmacKeys.marker(), projectKeyFor })

    let observer: ObserverScheduler | null = null
    const forward = (target: Relay): void => {
      target.forward().then(
        (result) => {
          if (result.sent > 0) log(`relay sent=${result.sent}`)
        },
        (error: unknown) => log(`relay failed: ${errorMessage(error)}`),
      )
    }
    // One listing of the spool serves a whole backlog, batch after batch.
    const spool = createSpoolCursor(join(dataDir, SPOOL_DIR))
    // One batch per run: a backlog is stored in turns, and requests are answered between them.
    const drain = (): void => {
      if (relay !== null) return forward(relay)
      const result = drainBatch(store.db, drainOptions(), spool)
      if (result.more) scheduler.request()
      const line = describeDrain(result)
      if (line !== null) log(line)
      if (result.inserted > 0) observer?.tick()
      // Transcripts are read only while the impact test is on or a debug watcher is connected, and after the drain,
      // so a hook's nudge never waits on a file read. Rows are stored for the impact test only; the watcher gets the trace.
      const impactTest = result.turnEnds.length > 0 && readDisplaySettings(store.db).holdout
      const watched = result.turnEnds.length > 0 && trace.watching(Date.now())
      if (impactTest || watched) {
        setTimeout(() => {
          try {
            const onRead = watched ? (turn: TurnEnd, usage: TurnUsage | null): void => {
              const event = turnTrace(store.db, turn, usage)
              if (event !== null) trace.push(event)
            } : undefined
            const stored = recordTurnUsage(store.db, freshTurnEnds(result.turnEnds, Date.now()), log, { store: impactTest, ...(onRead !== undefined ? { onRead } : {}) })
            if (stored > 0) log(`turn usage stored=${stored}`)
          } catch (error: unknown) {
            log(`turn usage failed: ${errorMessage(error)}`)
          }
        }, 0)
      }
    }
    const scheduler = createDrainScheduler(() => watch.step('drain', drain), (error) => log(`drain failed: ${errorMessage(error)}`), options.debounceMs)
    // What waits in the spool is stored once the server answers, not before: a backlog must not keep /health silent.
    // The marker key is made now all the same, as the first drain made it: a hook that finds none marks with a throwaway key.
    if (relay === null) hmacKeys.marker()
    scheduler.request()
    const interval = setInterval(() => scheduler.request(), options.fallbackDrainMs ?? FALLBACK_DRAIN_MS)
    const observing = options.observer !== undefined && relay === null ? startObserver(store.db, options.observer, hmacKeys, () => vectors.indexer?.tick(), log, trace, watch) : null
    observer = observing?.observer ?? null
    const readers = relay === null ? startReaders(store, dataDir, dbKeys, log) : deviceReaders(store)
    // Off the start path: one git call per project folder; a hub can only read its own folders, devices send theirs.
    let storeOpen = true
    const checkpoints = relay !== null ? null : startCheckpoints(store, dbKeys, log, () => storeOpen)
    const backfill = relay !== null ? null : setTimeout(() => void watch.step('repo merge', () => mergeSameRepos(store.db, backfillGit, log, () => storeOpen)), 0)
    const exclusive = exclusiveOverAll(vectors.queries, readers, () => checkpoints?.hold() ?? Promise.resolve(() => {}))
    // Bound once the data handlers exist, a few lines on; a retention run cannot come before that.
    let sizeChanged = (): void => {}
    const dataTicks = relay !== null ? { stop: () => {} } : startDataTicks({ db: store.db, markerKey: hmacKeys.marker, log, exclusive, onRemoved: () => sizeChanged(), step: watch.step, ...options.dataControl })

    // The hooks cannot open the store, so they read the display switches from a file this daemon keeps in step.
    const publishDisplay = (settings: DisplaySettings): void => {
      try {
        writeDisplayFile(dataDir, settings)
      } catch (error: unknown) {
        log(`display.json not written: ${errorMessage(error)}`)
      }
    }
    publishDisplay(readDisplaySettings(store.db))
    const context = contextHandler({
      // The prompt waits on this lookup; the first commit, which walks the history, comes with the folder's next capture.
      db: store.db, projectKeyFor: projectKeyFor.keyOnly, log, semantic: vectors.support.ok ? vectors.search : null, reads: readers.recall, deltaReads: readers.delta, traceReads: readers.reports, updates: { dataDir, version, envVars, canAutoUpdate, ...stagePlace },
      // Read per prompt, so a change from the dashboard or a restored store applies to the next one.
      holdout: { on: () => readDisplaySettings(store.db).holdout },
      trace,
    })
    // The device's own update notice rides on the hub's answer; the hub never sends its own to a device.
    const deviceContext = (target: Relay) => async (request: Parameters<typeof context>[0]) => {
      const startedAt = performance.now()
      const answer = await target.context(request)
      const notice = updateNoticeFor({ dataDir, version, envVars, canAutoUpdate, ...stagePlace }, request, Math.round(performance.now() - startedAt), Date.now())
      return { ...answer, ...noticeField(notice) }
    }
    sizeChanged = () => data.sizeChanged?.()
    const data = dataHandlers({ db: store.db, dbPath: store.path, markerKey: hmacKeys.marker, now: Date.now, log, holdoutHosts: HOLDOUT_HOSTS, onDisplay: publishDisplay, reports: readers.reports })
    // Measured once the start has settled, so `kinfold size` and the Data page find a report instead of waiting on dbstat.
    // The dashboard's kept reports are measured then too, so its first page finds them ready.
    const sizeWarm = relay !== null ? null : setTimeout(() => watch.step('size warm', () => {
      data.warmSize?.()
      void routes.memory.views?.warm()
    }), SIZE_WARM_DELAY_MS)
    const routes: CoreRoutes = {
      schemaVersion: store.schemaVersion,
      vectorSearch: vectors.support.ok ? 'on' : 'off',
      semanticSearch: vectors.search,
      onNudge: () => scheduler.request(),
      listSessions: (projectKey) => listRecentSessions(store.db, projectKey),
      context: relay === null ? context : deviceContext(relay),
      retryFailed: (target) => retryFailed(store.db, target, observer, log),
      observerSettings: settingsHandlers(store.db, Date.now, log, () => observing?.safety?.probeFailures() ?? [],
        keyStoreToken(options.keyStore !== undefined ? options.keyStore : defaultKeyStore(dataDir))),
      data,
      exclusive,
      memory: memoryHandlers(store.db, log, readers.reports, { deviceNames: () => pairedDeviceNames(dataDir, log) }),
      metrics: keptMetricsRoute(readers.reports, { onError: (error) => log(`metrics refresh failed: ${error instanceof Error ? error.name : 'error'}`) }),
      projects: (method, url, readBody) => projectRoute(method, url, readBody, { db: store.db, now: Date.now, log, device: relay !== null }),
      watch: (method, url) => watchRoute(store.db, method, url, Date.now()),
      debugWatch: (method, url) => debugWatchRoute(trace, method, url, Date.now()),
      sessions: (method, url) => sessionRoute(method, url, store.db, log),
      mcpRead: mcpReadHandler(store.db, log),
      reads: reads.deps,
      embeddingSettings: embeddingSettingsRoute({
        db: store.db,
        status: () => ({ ...vectors.spaces.status(), lastError: vectors.indexer?.status().lastError ?? null }),
        probe: (probe) => probeLocalLlmDims(probe),
        now: Date.now,
        apply: () => applyEmbedding(),
      }),
    }
    // Off the thread that answers hooks; on this connection if the worker cannot start.
    const snapshot = async (dest: string): Promise<number> => {
      const release = await (checkpoints?.hold() ?? Promise.resolve(() => {}))
      try {
        return await snapshotFile(dest)
      } finally {
        release()
      }
    }
    const snapshotFile = (dest: string): Promise<number> =>
      snapshotInWorker({ dbPath: store.path, key: dbKeys.read(), dest, libraryOverride: readEnv(process.env, 'SQLITE3MC_LIB') ?? null }).catch((error: unknown) => {
        log(`backup snapshot worker off (${error instanceof Error ? error.message : 'it failed'}); copying on the daemon connection`)
        return snapshotInto(store.db, dest)
      })
    const stop = async (): Promise<void> => {
      if (backfill !== null) clearTimeout(backfill)
      if (sizeWarm !== null) clearTimeout(sizeWarm)
      storeOpen = false
      clearInterval(interval)
      dataTicks.stop()
      if (observing !== null) stopObserver(observing)
      if (vectors.timer !== null) clearInterval(vectors.timer)
      vectors.indexer?.stop()
      await vectors.stopUpkeep()
      scheduler.stop()
      await vectors.indexer?.whenIdle()
      reads.close()
      // Before the store closes: a retention tick queued behind the worker would otherwise run on a closed db.
      await vectors.queries.close()
      await Promise.all([readers.recall.close(), readers.delta.close(), readers.reports.close()])
      await vectors.close()
      // Before the store closes, which then checkpoints what is left on its own connection.
      await checkpoints?.close()
      store.db.close()
    }
    const central = mode?.role !== 'hub' ? null : hubCore({
      db: store.db, marker: () => hmacKeys.marker(), onStored: () => observer?.tick(), context, reads: reads.deps,
      semantic: vectors.search, mcpRead: routes.mcpRead, now: Date.now,
    })
    const readersStarted = async (): Promise<void> => {
      await Promise.all([readers.recall.started?.(), readers.delta.started?.()])
    }
    const activity = (input: ActivityInput): void => {
      if (deviceActivity !== null) return deviceActivity.push(input)
      try {
        recordActivity(store.db, input)
      } catch (error: unknown) {
        log(`activity not recorded kind=${input.kind}: ${errorMessage(error)}`)
      }
    }
    if (relay === null) recordUpdateOnce(store.db, readAutoState(dataDir).updated, log)
    else noteDeviceUpdate(deviceActivity, readAutoState(dataDir).updated)
    return { routes, central, scheduler, observer, indexer: vectors.indexer, snapshot, stop, readersStarted, activity, passedTest: (provider) => passedTest(store.db, provider, log) }
  }

  let core = watch.step('core start', startCore)
  const onFatal = options.backup?.onFatal ?? ((reason: string): void => {
    log(`fatal: ${reason}; stopping so the service starts a fresh daemon`)
    setTimeout(() => process.exit(1), FATAL_EXIT_MS)
  })
  const restarter = createRestarter({
    current: () => core,
    start: () => watch.step('core start', startCore),
    adopt: (next) => {
      core = next
      Object.assign(deps, core.routes)
    },
    onFatal,
  })
  const restart = (between: () => Promise<void>): Promise<void> => restarter.restart(between)
  // One restart at a time, after the answer is out (the restart closes the store
  // the answer was read from). Changes saved while one runs collapse into one
  // more, which starts from what is saved by then: two restarts at once would
  // each stop the same core and start a core of their own.
  let embeddingRestart: Promise<void> | null = null
  let restartAgain = false
  applyEmbedding = () => {
    if (embeddingRestart !== null) {
      restartAgain = true
      return
    }
    embeddingRestart = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() => restarter.inFlight()?.catch(() => {}))
      .then(() => {
        log('embedding settings changed; restarting the store core')
        return restart(async () => {})
      })
      .catch((error: unknown) => log(`embedding restart failed: ${errorMessage(error)}`))
      .finally(() => {
        embeddingRestart = null
        if (restartAgain) {
          restartAgain = false
          applyEmbedding()
        }
      })
  }

  const backup: BackupRoutes = backupRoutes({
    dataDir,
    version,
    now: Date.now,
    log,
    snapshot: (dest) => core.snapshot(dest),
    keyStore: () => (options.keyStore !== undefined ? options.keyStore : defaultKeyStore(dataDir)),
    restart,
    sleep: options.backup?.sleep ?? ((ms) => Bun.sleep(ms)),
    onEvent: (kind, detail) => core.activity({ kind, at: Date.now(), detail }),
    uploadLimit: options.backup?.uploadLimit ?? (() => uploadLimitFor(dataDir, MAX_UPLOAD_BYTES)),
    ...(options.backup?.lockAttempts !== undefined ? { lockAttempts: options.backup.lockAttempts } : {}),
  })

  // A restore in progress is the user at work on the store: it counts as activity until it ends.
  const quietSince = (): number => (restarter.down() || restarter.inFlight() !== null ? updateNow() : lastEventAt)

  // Polled once a second by every watcher: an update state that cannot be read costs the line, never the rows.
  const watchUpdate = (): { version: string; message: string } | null => {
    try {
      const notice = bannerNotice(dataDir, version, envVars(), { capable: canAutoUpdate, now: updateNow(), ...stagePlace }, false)
      return notice === null ? null : { version: notice.version, message: userMessage(notice) }
    } catch {
      return null
    }
  }
  let hub: HubDaemon | null = null
  const dashboardNow = options.dashboard?.now ?? Date.now
  const dashboardAuth = createDashboardAuth(dashboardNow, fileSessionStore(dataDir, log))
  const deps: ServerDeps = {
    onActivity: agentEvent,
    port: options.port,
    token,
    version,
    hmacMode: () => hmacKeys.mode(),
    update: {
      banner: (markShown) => {
        const notice = bannerNotice(dataDir, version, envVars(), { capable: canAutoUpdate, now: updateNow(), ...stagePlace }, markShown)
        return notice === null ? null : { version: notice.version, message: userMessage(notice) }
      },
      auto: () => autoUpdateView(dataDir, version, envVars(), updateNow()),
      quietForMs: () => Math.max(0, updateNow() - quietSince()),
      setAuto: (enabled) => {
        const saved = setAutoUpdate(dataDir, enabled, updateNow())
        if (saved) log(`auto-update turned ${enabled ? 'on' : 'off'} from the dashboard`)
        return saved
      },
      ...updateRouteHandlers({
        dataDir,
        version,
        platform: options.autoUpdate?.platform ?? currentPlatform().node,
        envVars,
        now: updateNow,
        log,
        storeBusy: () => (restarter.down() || restarter.inFlight() !== null || backup.busy() ? 'a backup or restore is running; try again when it finishes' : null),
        program: options.autoUpdate === undefined ? null : { path: options.autoUpdate.program, os: options.autoUpdate.os },
        ...(options.autoUpdate?.spawn !== undefined ? { spawn: options.autoUpdate.spawn } : {}),
        ...(options.autoUpdate?.exists !== undefined ? { exists: options.autoUpdate.exists } : {}),
      }),
    },
    observerModels: observerModelsRoute(options.observer?.cliRunnerFor ?? null, log, Date.now),
    observerTest: observerTestRoute(createObserverTester(options.observer?.runnerFor ?? null, log, (provider) => core.passedTest(provider))),
    auth: dashboardAuth,
    dashboardEvents: createDashboardEvents(dashboardNow),
    onSignIn: () => core.activity({ kind: 'sign-in', at: Date.now() }),
    daemonLogPath: join(dataDir, 'logs', 'daemon.log'),
    deviceActivity: () => deviceActivity?.rows() ?? [],
    backup,
    unavailable: () => (restarter.down() ? RESTORING : null),
    log,
    step: watch.step,
    ...(relay !== null && deviceMode !== null ? { device: { relay, hubName: deviceMode.hubName, watchUpdate } } : {}),
    centralStatus: async (check) => {
      if (check && relay !== null) await relay.hello()
      return centralStatus(dataDir, mode, hub, relay)
    },
    ...core.routes,
    // kinfold watch and the OpenCode toast read /watch, so the update the user is owed rides along there; reading it marks nothing.
    watch: (method, url) => {
      const answer = core.routes.watch?.(method, url) ?? { status: 404, body: { error: 'not found' } }
      if (answer.status !== 200) return answer
      return { ...answer, body: { ...(answer.body as Record<string, unknown>), update: watchUpdate() } }
    },
  }
  const server = startServer(deps)
  // A dashboard view a device asks for runs through this daemon's own loopback routes, with its token.
  const view = async (path: string): Promise<{ status: number; body: unknown }> => {
    const response = await handleRequest(new Request(`http://${LOOPBACK_HOST}:${server.port}${path}`, { headers: { host: `${LOOPBACK_HOST}:${server.port}`, authorization: `Bearer ${token}` } }), server.port, deps)
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  hub = mode?.role !== 'hub' ? null : startHubWhenReady({
    dataDir, version, port: mode.port, tailscale: options.central?.tailscale ?? systemTailscale(),
    core: () => {
      if (core.central === null) throw new Error('the store is not open')
      return core.central
    },
    view, log,
    onPaired: (device) => core.activity({ kind: 'device-paired', at: Date.now(), device }),
    ...(options.central?.allowLoopback === true ? { allowLoopback: true } : {}),
    ...(options.central?.hubRetryMs !== undefined ? { retryMs: options.central.hubRetryMs } : {}),
  })
  const infoPath = join(dataDir, DAEMON_INFO_FILE)
  const info: DaemonInfo = { pid: process.pid, port: server.port }
  // The token first: a client that reads the new daemon.json must find the token that goes with it.
  writeFileAtomic(join(dataDir, TOKEN_FILE), token, DATA_FILE_MODE)
  writePrivateFile(infoPath, JSON.stringify(info), false)
  const rotation = setInterval(() => watch.step('hmac rotation', hmacKeys.tick), options.hmac?.rotationTickMs ?? ROTATION_TICK_MS)
  const updateChecks = startUpdateChecks({
    dataDir,
    version,
    fetch: options.updateCheck?.fetch ?? ((url, init) => fetch(url, init)),
    now: updateNow,
    envVars,
    log,
  })
  const autoUpdates = options.autoUpdate === undefined ? null : startAutoUpdates({
    dataDir,
    version,
    program: options.autoUpdate.program,
    os: options.autoUpdate.os,
    now: updateNow,
    envVars,
    log,
    // A restore in progress is the user at work on the store: it counts as activity until it ends.
    lastEventAt: quietSince,
    ...(options.autoUpdate.spawn !== undefined ? { spawn: options.autoUpdate.spawn } : {}),
    ...(options.autoUpdate.exists !== undefined ? { exists: options.autoUpdate.exists } : {}),
  }, options.autoUpdate.tickMs)
  // Releases that wait for a yes are downloaded where an installed program could take them.
  const staging = options.autoUpdate === undefined ? null : startStaging({
    dataDir,
    version,
    platform: options.autoUpdate.platform ?? currentPlatform().node,
    arch: options.autoUpdate.arch ?? process.arch,
    fetch: options.updateCheck?.fetch ?? ((url, init) => fetch(url, init)),
    envVars,
    now: updateNow,
    log,
  }, options.autoUpdate.tickMs)
  log(`listening on 127.0.0.1:${server.port} schema=${core.routes.schemaVersion} observer=${core.observer !== null ? 'on' : 'off'}`)

  const stop = async (): Promise<void> => {
    // Before any await, so a stop that hangs or throws still keeps each lease's latest expiry: renewals are not written one by one.
    dashboardAuth.flush()
    watch.stop()
    clearInterval(rotation)
    updateChecks.stop()
    autoUpdates?.stop()
    staging?.stop()
    // A restore between its journal and its last step would leave the marker, and the next daemon
    // could not open the store until someone ran kinfold key resume. It ends on its own: the wait
    // for the store is bounded, and then it finishes or puts the old store back.
    await restarter.inFlight()?.catch(() => {})
    await hub?.stop()
    await server.stop()
    // A core a restore already closed, and could not replace, has nothing left to stop.
    if (!restarter.down()) await core.stop()
    removeOwnInfoFile(infoPath)
  }
  return {
    port: server.port,
    dataDir,
    get scheduler() {
      return core.scheduler
    },
    get observer() {
      return core.observer
    },
    hmacKeys,
    get vectors() {
      return core.indexer
    },
    central: { hub, relay, status: () => centralStatus(dataDir, mode, hub, relay) },
    readersStarted: () => core.readersStarted(),
    stop,
  }
}
