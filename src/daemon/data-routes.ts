// The /data routes, behind the same token and Host rules as
// every other route (server.ts checks both before it gets here). The
// dashboard and `kinfold size|retention|scan|findings|purge` call them; the
// daemon stays the only writer. Answers carry ids, counts, rule names,
// sizes and project keys; never stored text. Logs drop project keys too.

import type { Parsed } from '../context/types'
import { type PurgeReport, describePurge, purge } from '../data-control/purge'
import { type PurgeRequest, parseFindingsQuery, parsePurgeBody, parseResolveBody, parseRetentionRequest } from '../data-control/requests'
import { type ResolveAction, type ResolveOutcome, resolveFinding } from '../data-control/resolve'
import { type RetentionOutcome, type RetentionPreview, applyRetention, describePreview, describeRetention, previewRetention } from '../data-control/retention'
import { type ScanResult, describeScan, scanUntil } from '../data-control/scanner'
import type { SizeReport } from '../data-control/size'
import { SizeStillComputingError, createSizeCache } from './size-cache'
import type { Database } from '../sqlite/types'
import { type DataSettings, type DataSettingsChange, readDataSettings, writeDataSettings } from '../store/data-settings-store'
import { type DisplayChange, type DisplaySettings, readDisplaySettings, writeDisplaySettings } from '../store/display-settings'
import { type Finding, type FindingQuery, listFindings, pendingByRule } from '../store/findings-store'
import type { MarkerKey } from '../redaction/redact'
import { type Exclusive, runNow } from '../vectors/vector-worker'
import { type StoreReader, inlineStoreReader } from '../workers/store-reader'

/** An on-demand scan works this long, then answers with what is left; the tick carries on. */
export const SCAN_REQUEST_BUDGET_MS = 2_000

export interface FindingsView {
  findings: Finding[]
  pendingByRule: Record<string, number>
}

export interface DataHandlers {
  /** Read through the reports reader and kept (size-cache.ts): on a large store dbstat takes seconds. */
  size: () => Promise<SizeReport & { measuredAt: number }>
  /** Starts the first size read in the background, so the first ask finds a report. */
  warmSize?: () => void
  /** Rows went (a scheduled retention run): the kept size report is measured again on the next ask. */
  sizeChanged?: () => void
  retention: () => DataSettings
  /** Saves, then applies the new retention at once, so the answer shows what it removed. */
  putRetention: (change: DataSettingsChange) => { saved: DataSettings; applied: RetentionOutcome }
  /** Counts what putRetention would expire at once; saves nothing (PUT with preview: true). */
  previewRetention: (change: DataSettingsChange) => RetentionPreview
  scan: () => ScanResult
  findings: (query: FindingQuery) => FindingsView
  resolve: (id: number, action: ResolveAction) => ResolveOutcome
  purge: (request: PurgeRequest) => PurgeReport
  /** GET /data/display: whether agents show what was recalled, and the opt-in impact test. */
  display: () => DisplayView
  putDisplay: (change: DisplayChange) => DisplayView
}

/** The two switches, plus which agents the impact test can hold a prompt out for, so a page can say "on for Claude Code". */
export interface DisplayView extends DisplaySettings {
  holdoutHosts: readonly string[]
}

export interface DataDeps {
  db: Database
  dbPath: string
  markerKey: () => MarkerKey
  now: () => number
  log: (line: string) => void
  /** The agents the impact test covers. */
  holdoutHosts?: readonly string[]
  /** Where the size report is read; default db, on this thread. The daemon passes its reports reader. */
  reports?: StoreReader
  /** Called after the display switches are saved; the daemon rewrites display.json for the hooks. */
  onDisplay?: (settings: DisplaySettings) => void
}

/** PUT /data/display takes {"showRecall": boolean} and/or {"holdout": boolean}, and nothing else. */
export function parseDisplayChange(body: unknown): Parsed<DisplayChange> {
  const usage = 'body must be {"showRecall": boolean} and/or {"holdout": boolean}'
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: usage }
  const keys = Object.keys(body)
  if (keys.length === 0 || keys.some((key) => key !== 'showRecall' && key !== 'holdout')) return { ok: false, error: usage }
  const { showRecall, holdout } = body as { showRecall?: unknown; holdout?: unknown }
  if ((showRecall !== undefined && typeof showRecall !== 'boolean') || (holdout !== undefined && typeof holdout !== 'boolean')) return { ok: false, error: usage }
  return { ok: true, value: { ...(showRecall !== undefined ? { showRecall } : {}), ...(holdout !== undefined ? { holdout } : {}) } }
}

export function dataHandlers(deps: DataDeps): DataHandlers {
  const { db, log } = deps
  const displayView = (settings: DisplaySettings): DisplayView => ({ ...settings, holdoutHosts: deps.holdoutHosts ?? [] })
  const sizes = createSizeCache(() => (deps.reports ?? inlineStoreReader(db, deps.dbPath)).run('dataSize', {}), { now: deps.now })
  return {
    display: () => displayView(readDisplaySettings(db)),
    putDisplay: (change) => {
      const saved = writeDisplaySettings(db, change, deps.now())
      deps.onDisplay?.(saved)
      log(`display settings saved show_recall=${saved.showRecall} holdout=${saved.holdout}`)
      return displayView(saved)
    },
    size: async () => {
      const measured = await sizes.get()
      return { ...measured.report, measuredAt: measured.measuredAt }
    },
    warmSize: () => sizes.refresh(),
    sizeChanged: () => sizes.stale(),
    retention: () => readDataSettings(db),
    putRetention: (change) => {
      const saved = writeDataSettings(db, change, deps.now())
      const applied = applyRetention(db, deps.now())
      sizes.stale()
      log(`data retention saved events=${saved.retention.events} prompts=${saved.retention.prompts} observations=${saved.retention.observations} summaries=${saved.retention.summaries} warn_bytes=${saved.warnBytes}`)
      const line = describeRetention(applied)
      if (line !== null) log(line)
      return { saved, applied }
    },
    previewRetention: (change) => {
      const preview = previewRetention(db, change, deps.now())
      log(describePreview(preview))
      return preview
    },
    scan: () => {
      const result = scanUntil(db, { ...deps.markerKey(), now: deps.now }, SCAN_REQUEST_BUDGET_MS)
      log(describeScan(result))
      return result
    },
    findings: (query) => ({ findings: listFindings(db, query), pendingByRule: pendingByRule(db) }),
    resolve: (id, action) => {
      const outcome = resolveFinding(db, id, action, { ...deps.markerKey(), now: deps.now })
      if (outcome.ok && outcome.purge !== null) sizes.stale()
      log(`data finding resolve id=${id} action=${action} ${outcome.ok ? 'ok' : `refused=${outcome.status}`}`)
      return outcome
    },
    purge: (request) => {
      const report = purge(db, request.target, { dryRun: request.dryRun, now: deps.now })
      if (!request.dryRun) sizes.stale()
      log(describePurge(request.target, report))
      return report
    },
  }
}

export interface RouteAnswer {
  status: number
  body: unknown
}

type ReadBody = () => Promise<Parsed<unknown>>

const METHOD_NOT_ALLOWED: RouteAnswer = { status: 405, body: { error: 'method not allowed' } }
const RESOLVE_PATH = /^\/data\/findings\/(\d{1,15})\/resolve$/

async function withBody<T>(readBody: ReadBody, parse: (body: unknown) => Parsed<T>, answer: (value: T) => RouteAnswer | Promise<RouteAnswer>): Promise<RouteAnswer> {
  const body = await readBody()
  const parsed = body.ok ? parse(body.value) : body
  return parsed.ok ? answer(parsed.value) : { status: 400, body: { error: parsed.error } }
}

function resolveAnswer(outcome: ResolveOutcome): RouteAnswer {
  if (!outcome.ok) return { status: outcome.status, body: { error: outcome.error } }
  return { status: 200, body: { resolved: outcome.finding, purge: outcome.purge } }
}

async function retentionRoute(method: string, readBody: ReadBody, handlers: DataHandlers, exclusive: Exclusive): Promise<RouteAnswer> {
  if (method === 'GET') return { status: 200, body: handlers.retention() }
  if (method !== 'PUT') return METHOD_NOT_ALLOWED
  return withBody(readBody, parseRetentionRequest, async ({ change, preview }) => ({
    status: 200,
    body: preview ? { preview: handlers.previewRetention(change) } : await exclusive(() => handlers.putRetention(change)),
  }))
}

/** A report still being worked out is a 503 that says so: the HTTP server drops a request that waits past its idle timeout. */
async function sizeRoute(handlers: DataHandlers): Promise<RouteAnswer> {
  try {
    return { status: 200, body: await handlers.size() }
  } catch (error: unknown) {
    if (error instanceof SizeStillComputingError) return { status: 503, body: { error: error.message } }
    throw error
  }
}

/**
 * Null when the path is not a /data route, so the caller answers 404.
 * Retention, purge and resolve end with a TRUNCATE checkpoint, so they run
 * through `exclusive`: never beside the vector worker's open read snapshot.
 */
export async function dataRoute(method: string, url: URL, readBody: ReadBody, handlers: DataHandlers, exclusive: Exclusive = runNow): Promise<RouteAnswer | null> {
  const path = url.pathname
  if (path === '/data/size') return method === 'GET' ? sizeRoute(handlers) : METHOD_NOT_ALLOWED
  if (path === '/data/retention') return retentionRoute(method, readBody, handlers, exclusive)
  if (path === '/data/display') {
    if (method === 'GET') return { status: 200, body: handlers.display() }
    if (method !== 'PUT') return METHOD_NOT_ALLOWED
    return withBody(readBody, parseDisplayChange, (change) => ({ status: 200, body: handlers.putDisplay(change) }))
  }
  if (path === '/data/scan') return method === 'POST' ? { status: 200, body: handlers.scan() } : METHOD_NOT_ALLOWED
  if (path === '/data/findings') {
    if (method !== 'GET') return METHOD_NOT_ALLOWED
    const query = parseFindingsQuery(url.searchParams)
    return query.ok ? { status: 200, body: handlers.findings(query.value) } : { status: 400, body: { error: query.error } }
  }
  if (path === '/data/purge') {
    if (method !== 'POST') return METHOD_NOT_ALLOWED
    return withBody(readBody, parsePurgeBody, async (request) => ({ status: 200, body: await exclusive(() => handlers.purge(request)) }))
  }
  const resolve = RESOLVE_PATH.exec(path)
  if (resolve === null) return null
  if (method !== 'POST') return METHOD_NOT_ALLOWED
  return withBody(readBody, parseResolveBody, async (action) => resolveAnswer(await exclusive(() => handlers.resolve(Number(resolve[1]), action))))
}
