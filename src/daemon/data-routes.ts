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
import { type SizeReport, sizeReport } from '../data-control/size'
import type { Database } from '../sqlite/types'
import { type DataSettings, type DataSettingsChange, readDataSettings, writeDataSettings } from '../store/data-settings-store'
import { type Finding, type FindingQuery, listFindings, pendingByRule } from '../store/findings-store'
import type { MarkerKey } from '../redaction/redact'
import { type Exclusive, runNow } from '../vectors/vector-worker'

/** An on-demand scan works this long, then answers with what is left; the tick carries on. */
export const SCAN_REQUEST_BUDGET_MS = 2_000

export interface FindingsView {
  findings: Finding[]
  pendingByRule: Record<string, number>
}

export interface DataHandlers {
  size: () => SizeReport
  retention: () => DataSettings
  /** Saves, then applies the new retention at once, so the answer shows what it removed. */
  putRetention: (change: DataSettingsChange) => { saved: DataSettings; applied: RetentionOutcome }
  /** Counts what putRetention would expire at once; saves nothing (PUT with preview: true). */
  previewRetention: (change: DataSettingsChange) => RetentionPreview
  scan: () => ScanResult
  findings: (query: FindingQuery) => FindingsView
  resolve: (id: number, action: ResolveAction) => ResolveOutcome
  purge: (request: PurgeRequest) => PurgeReport
}

export interface DataDeps {
  db: Database
  dbPath: string
  markerKey: () => MarkerKey
  now: () => number
  log: (line: string) => void
}

export function dataHandlers(deps: DataDeps): DataHandlers {
  const { db, log } = deps
  return {
    size: () => sizeReport(db, deps.dbPath),
    retention: () => readDataSettings(db),
    putRetention: (change) => {
      const saved = writeDataSettings(db, change, deps.now())
      const applied = applyRetention(db, deps.now())
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
      log(`data finding resolve id=${id} action=${action} ${outcome.ok ? 'ok' : `refused=${outcome.status}`}`)
      return outcome
    },
    purge: (request) => {
      const report = purge(db, request.target, { dryRun: request.dryRun, now: deps.now })
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

/**
 * Null when the path is not a /data route, so the caller answers 404.
 * Retention, purge and resolve end with a TRUNCATE checkpoint, so they run
 * through `exclusive`: never beside the vector worker's open read snapshot.
 */
export async function dataRoute(method: string, url: URL, readBody: ReadBody, handlers: DataHandlers, exclusive: Exclusive = runNow): Promise<RouteAnswer | null> {
  const path = url.pathname
  if (path === '/data/size') return method === 'GET' ? { status: 200, body: handlers.size() } : METHOD_NOT_ALLOWED
  if (path === '/data/retention') return retentionRoute(method, readBody, handlers, exclusive)
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
