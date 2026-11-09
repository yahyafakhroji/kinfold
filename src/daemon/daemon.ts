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

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { envName } from '../env-names'
import type { DbKeyStore } from '../sqlite/keys'
import { plaintextBesideKey } from '../sqlite/open'
import type { Database } from '../sqlite/types'
import { DAEMON_INFO_FILE, SPOOL_DIR, TOKEN_FILE, ensureDataDir, readOrCreateSecret, writePrivateFile } from '../store/data-dir'
import { openStore } from '../store/db'
import { DAEMON_GIT_TIMEOUT_MS, createProjectKeyResolver, gitRunnerWithTimeout } from '../store/project-key'
import { listRecentSessions } from '../store/reads'
import { rebuildProjectPacks } from '../context/packs'
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
import { type DrainOptions, type DrainResult, drainSpool } from './ingest'
import { logLine } from './log-line'
import { DEFAULT_OBSERVER_TICK_MS, type ObserverScheduleConfig, type ObserverScheduler, createObserverScheduler } from './observer-scheduler'
import { type DrainScheduler, createDrainScheduler } from './scheduler'
import { createDashboardAuth } from '../dashboard/auth'
import { metricsRoute } from '../dashboard/metrics'
import { contextHandler } from './context-route'
import { dataHandlers } from './data-routes'
import { mcpReadHandler } from './mcp-read-route'
import { memoryHandlers } from './memory-routes'
import { observerModelsRoute } from './observer-models-route'
import { createObserverTester, observerTestRoute } from './observer-test'
import { startDataTicks } from './data-ticks'
import { VERSION } from '../version'
import { type UpdateCheckDeps, startUpdateChecks } from '../update/check'
import { availableMessage, pendingNotice } from '../update/notice'
import { readUpdateState } from '../update/state'
import { readInstallRecord } from '../install/setup/record'
import { startServer } from './server'
import type { ReadRouteDeps } from './read-routes'
import { type MemoryReader, openMemoryReader } from '../mcp/reader'
import { MCP_SEMANTIC_TIMEOUT_MS, type SemanticClient } from '../mcp/semantic-client'
import { settingsHandlers } from './settings-route'
import type { Embedder } from '../vectors/embedder'
import { type Support, loadVec0 } from '../vectors/extension'
import { DEFAULT_INDEX_TICK_MS, type VectorIndexer, createVectorIndexer } from '../vectors/indexer'
import { type SemanticAnswer, type SemanticRequest, createSemanticSearch } from '../vectors/search'

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
  /** Rotation tick and clock, for tests. */
  hmac?: { rotationTickMs?: number; now?: () => number }
  /** Semantic search. Without it there is no embedding and /search/semantic answers unavailable. */
  vectors?: DaemonVectorOptions
  /** The daily update check's fetch, clock and environment, for tests. It never runs for a 0.0.0-dev version. */
  updateCheck?: Partial<Pick<UpdateCheckDeps, 'fetch' | 'now' | 'envVars'>>
}

export interface DaemonVectorOptions {
  /** Null without an OpenRouter key: nothing is embedded. */
  embedder: Embedder | null
  tickMs?: number
}

interface Vectors {
  indexer: VectorIndexer | null
  support: Support
  search: (request: SemanticRequest) => Promise<SemanticAnswer>
  timer: Timer | null
}

const VECTORS_OFF: Support = { ok: false, reason: 'semantic search is not configured in this daemon' }

/** Loads sqlite-vec, starts the indexer when there is an embedder, and builds the search. Indexing works without the extension. */
function startVectors(db: Database, dataDir: string, options: DaemonVectorOptions | undefined, log: (line: string) => void): Vectors {
  const support = options === undefined ? VECTORS_OFF : loadVec0(db, dataDir)
  const embedder = options?.embedder ?? null
  log(`vectors search=${support.ok ? `on (${support.detail})` : `off (${support.reason})`} embedder=${embedder === null ? 'none' : embedder.model}`)
  const indexer = embedder === null ? null : createVectorIndexer({ db, embedder, log })
  const timer = indexer === null ? null : setInterval(() => indexer.tick(), options?.tickMs ?? DEFAULT_INDEX_TICK_MS)
  indexer?.tick()
  return { indexer, support, search: createSemanticSearch({ db, embedder, support }), timer }
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
  scheduler: DrainScheduler
  observer: ObserverScheduler | null
  hmacKeys: HmacKeyState
  /** Null without an embedder. */
  vectors: VectorIndexer | null
  stop: () => Promise<void>
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

/** Settings or credential changes send exhausted failed events back to pending, then the observer looks again. */
function resetCheck(db: Database, options: DaemonObserverOptions, keys: HmacKeyState, observer: ObserverScheduler, log: (line: string) => void): void {
  try {
    const outcomes = checkFailedResets({ db, credentials: options.credentials ?? NO_CREDENTIALS, fingerprintKey: keys.fingerprint(), log })
    if (outcomes.some((outcome) => outcome.events > 0)) observer.tick()
  } catch (error: unknown) {
    log(`observer reset check failed: ${errorMessage(error)}`)
  }
}

/** Recovers runs a crash left open, then ticks on an interval and after every drain that inserted rows. */
function startObserver(db: Database, options: DaemonObserverOptions, keys: HmacKeyState, afterWrite: () => void, log: (line: string) => void): Observing {
  const recovered = recoverInterrupted(db, Date.now())
  if (recovered.events > 0 || recovered.runs > 0) log(`observer recovered events=${recovered.events} runs=${recovered.runs}`)
  const safety = options.safety?.(db, log)
  const observer = createObserverScheduler({
    db,
    processSession: async (sessionId) => {
      const outcome = await processSessionBatch({ db, runnerFor: options.runnerFor, log, ...(safety !== undefined ? { safety } : {}) }, sessionId)
      rebuildAfterWrite(db, sessionId, outcome, log)
      if (outcome.status === 'succeeded' && outcome.inserted > 0) afterWrite()
      return outcome
    },
    ...(options.schedule !== undefined ? { config: options.schedule } : {}),
    log,
  })
  const check = (): void => resetCheck(db, options, keys, observer, log)
  const timers = [
    setInterval(() => observer.tick(), options.tickMs ?? DEFAULT_OBSERVER_TICK_MS),
    setInterval(check, options.resetCheckMs ?? DEFAULT_RESET_CHECK_MS),
  ]
  check()
  observer.tick()
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
 * file cannot be opened), so it never shares the writer's statements.
 */
function daemonReads(dataDir: string, projectKeyFor: ReadRouteDeps['projectKeyFor'], vectors: Vectors): DaemonReads {
  let reader: MemoryReader | null = null
  const semantic: SemanticClient = (query) => vectors.search({ ...query, deadlineMs: MCP_SEMANTIC_TIMEOUT_MS })
  return {
    deps: {
      reader: () => {
        reader ??= openMemoryReader(dataDir)
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
  const store = openStore(dataDir, { keys: options.dbKeys })
  // Decrypted pages stay here between requests; with SQLite's 2 MB default every prompt decrypted its pages again.
  store.db.run(`PRAGMA cache_size = -${DAEMON_CACHE_KIB}`)
  warnIfPlaintextBesideKey(store.path, log, options.dbKeys)
  const token = readOrCreateSecret(join(dataDir, TOKEN_FILE))
  const hmacKeys = createHmacKeys({ dataDir, keychain: options.keychain ?? NO_CREDENTIALS, now: options.hmac?.now ?? Date.now, log })
  const vectors = startVectors(store.db, dataDir, options.vectors, log)
  const projectKeyFor = createProjectKeyResolver(gitRunnerWithTimeout(DAEMON_GIT_TIMEOUT_MS))
  const reads = daemonReads(dataDir, projectKeyFor, vectors)
  const drainOptions = (): DrainOptions => ({ spoolDir: join(dataDir, SPOOL_DIR), ...hmacKeys.marker(), projectKeyFor })

  let observer: ObserverScheduler | null = null
  const drain = (): void => {
    const result = drainSpool(store.db, drainOptions())
    const line = describeDrain(result)
    if (line !== null) log(line)
    if (result.inserted > 0) observer?.tick()
  }
  const scheduler = createDrainScheduler(drain, (error) => log(`drain failed: ${errorMessage(error)}`), options.debounceMs)
  drain()

  const server = startServer({
    port: options.port,
    token,
    version: options.version ?? VERSION,
    schemaVersion: store.schemaVersion,
    hmacMode: () => hmacKeys.mode(),
    vectorSearch: vectors.support.ok ? 'on' : 'off',
    semanticSearch: vectors.search,
    onNudge: () => scheduler.request(),
    listSessions: (projectKey) => listRecentSessions(store.db, projectKey),
    context: contextHandler({ db: store.db, projectKeyFor, log, semantic: vectors.support.ok ? vectors.search : null, updates: { dataDir, version: options.version ?? VERSION, envVars: options.updateCheck?.envVars ?? (() => process.env) } }),
    retryFailed: (target) => retryFailed(store.db, target, observer, log),
    // Read at request time: `observing` starts after the server, and no request is served before then.
    observerSettings: settingsHandlers(store.db, Date.now, log, () => observing?.safety?.probeFailures() ?? []),
    data: dataHandlers({ db: store.db, dbPath: store.path, markerKey: hmacKeys.marker, now: Date.now, log }),
    memory: memoryHandlers(store.db, log),
    updateBanner: () => {
      const notice = pendingNotice(readUpdateState(dataDir), readInstallRecord(dataDir), options.version ?? VERSION, (options.updateCheck?.envVars ?? (() => process.env))())
      return notice === null ? null : { version: notice.version, message: availableMessage(notice) }
    },
    metrics: (window) => metricsRoute(store.db, window),
    mcpRead: mcpReadHandler(store.db, log),
    observerModels: observerModelsRoute(options.observer?.cliRunnerFor ?? null, log, Date.now),
    observerTest: observerTestRoute(createObserverTester(options.observer?.runnerFor ?? null, log)),
    auth: createDashboardAuth(),
    reads: reads.deps,
    log,
  })
  const infoPath = join(dataDir, DAEMON_INFO_FILE)
  const info: DaemonInfo = { pid: process.pid, port: server.port }
  writePrivateFile(infoPath, JSON.stringify(info), false)
  const interval = setInterval(() => scheduler.request(), options.fallbackDrainMs ?? FALLBACK_DRAIN_MS)
  const rotation = setInterval(hmacKeys.tick, options.hmac?.rotationTickMs ?? ROTATION_TICK_MS)
  const observing = options.observer !== undefined ? startObserver(store.db, options.observer, hmacKeys, () => vectors.indexer?.tick(), log) : null
  observer = observing?.observer ?? null
  const dataTicks = startDataTicks({ db: store.db, markerKey: hmacKeys.marker, log, ...options.dataControl })
  const updateChecks = startUpdateChecks({
    dataDir,
    version: options.version ?? VERSION,
    fetch: options.updateCheck?.fetch ?? ((url, init) => fetch(url, init)),
    now: options.updateCheck?.now ?? Date.now,
    envVars: options.updateCheck?.envVars ?? (() => process.env),
    log,
  })
  log(`listening on 127.0.0.1:${server.port} schema=${store.schemaVersion} observer=${observer !== null ? 'on' : 'off'}`)

  const stop = async (): Promise<void> => {
    clearInterval(interval)
    clearInterval(rotation)
    dataTicks.stop()
    updateChecks.stop()
    if (observing !== null) stopObserver(observing)
    if (vectors.timer !== null) clearInterval(vectors.timer)
    vectors.indexer?.stop()
    scheduler.stop()
    await server.stop()
    await vectors.indexer?.whenIdle()
    removeOwnInfoFile(infoPath)
    reads.close()
    store.db.close()
  }
  return { port: server.port, dataDir, scheduler, observer, hmacKeys, vectors: vectors.indexer, stop }
}
