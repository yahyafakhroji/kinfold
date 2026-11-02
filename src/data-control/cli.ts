// `kinfold size|retention|scan|findings|purge`: thin clients of the daemon's /data
// routes. The CLI never opens the database; it reads daemon.json and
// daemon.token like the installer does, sends one request, and prints the
// answer as counts, sizes, ids and rule names. A daemon that is down or
// answers non-200 is exit 1 with the daemon's field message.

import { isRecord } from '../contract/event'
import { readDaemonEndpoint } from '../daemon/daemon-info'
import type { FindingsView } from '../daemon/data-routes'
import type { DataArgs } from '../install/args'
import type { InstallEnv } from '../install/env'
import { type DataSettings, RETENTION_TABLES } from '../store/data-settings-store'
import type { Finding } from '../store/findings-store'
import type { PurgeReport } from './purge'
import type { RetentionOutcome, RetentionPreview } from './retention'
import type { ScanResult } from './scanner'
import type { SizeReport } from './size'

export type DataCliEnv = Pick<InstallEnv, 'dataDir' | 'fetch' | 'out'>

const EXIT_OK = 0
const EXIT_FAILED = 1
/** A scan request works up to 2 s on the daemon side; leave room for it. */
const REQUEST_TIMEOUT_MS = 15_000

type Answer = { ok: true; body: unknown } | { ok: false; error: string }

interface Planned {
  method: string
  path: string
  body?: unknown
  lines: (body: unknown) => string[]
}

async function call(env: DataCliEnv, method: string, path: string, body?: unknown): Promise<Answer> {
  const endpoint = readDaemonEndpoint(env.dataDir)
  if (endpoint === null) return { ok: false, error: 'the daemon is not running (no daemon.json or daemon.token)' }
  try {
    const response = await env.fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${endpoint.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const parsed: unknown = await response.json().catch(() => null)
    if (response.status === 200) return { ok: true, body: parsed }
    const detail = isRecord(parsed) && typeof parsed.error === 'string' ? `: ${parsed.error}` : ''
    return { ok: false, error: `${method} ${path} answered ${response.status}${detail}` }
  } catch (error: unknown) {
    return { ok: false, error: `${method} ${path} failed (${error instanceof Error ? error.name : 'error'})` }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function sizeLines(report: SizeReport): string[] {
  const { files } = report
  return [
    `database ${formatBytes(report.totalBytes)} (db ${formatBytes(files.db)}, wal ${formatBytes(files.wal)}, shm ${formatBytes(files.shm)}); free pages ${formatBytes(report.freeBytes)}`,
    `warning threshold ${formatBytes(report.warnBytes)}: ${report.overWarn ? 'OVER' : 'ok'}`,
    `by table (${report.source}):`,
    ...report.tables.map((table) => `  ${table.name} ${formatBytes(table.bytes)}`),
    'by project (stored text):',
    ...report.projects.map((project) => `  ${project.displayName} [${project.projectKey}] events ${project.events} (${formatBytes(project.eventBytes)}), `
      + `observations ${project.observations} (${formatBytes(project.observationBytes)}), prompts ${formatBytes(project.promptBytes)}`),
  ]
}

const days = (value: number | null): string => (value === null ? 'keep' : `${value} days`)

function retentionLines(settings: DataSettings, applied: RetentionOutcome | null): string[] {
  const { retention } = settings
  const lines = [
    `retention: events ${days(retention.events)} (payload), prompts ${days(retention.prompts)} (text), observations ${days(retention.observations)}, summaries ${days(retention.summaries)}`,
    `size warning at ${formatBytes(settings.warnBytes)}`,
  ]
  if (applied === null) return lines
  return [...lines, `applied now: events ${applied.events}, prompts ${applied.prompts}, observations ${applied.observations}, summaries ${applied.summaries}`]
}

const rulesOf = (byRule: Readonly<Record<string, number>>): string => Object.entries(byRule).map(([rule, n]) => `${rule}=${n}`).join(', ') || 'none'

function scanLines(result: ScanResult): string[] {
  return [`scanned ${result.scanned} rows in ${result.ms} ms; new findings ${result.findings} (${rulesOf(result.byRule)}); ${result.remaining} rows left`]
}

function findingLine(finding: Finding): string {
  return `#${finding.id} ${finding.table} ${finding.rowId} ${finding.field ?? '-'} ${finding.rule} v${finding.ruleVersion} x${finding.matches} ${finding.action}`
}

function findingsLines(view: FindingsView): string[] {
  return [`pending by rule: ${rulesOf(view.pendingByRule)}`, ...(view.findings.length === 0 ? ['  no findings'] : view.findings.map((finding) => `  ${findingLine(finding)}`))]
}

function purgeLines(report: PurgeReport): string[] {
  const counts = Object.entries(report.counts).filter(([, n]) => n > 0).map(([table, n]) => `${table} ${n}`)
  const head = report.dryRun ? 'dry run, nothing changed; would remove' : 'removed'
  const scrubbed = report.scrub !== null ? `, pages freed ${report.scrub.freedPages}, wal emptied ${report.scrub.walTruncated ? 'yes' : 'no'}` : ''
  return [`${head}: ${counts.length > 0 ? counts.join(', ') : 'nothing'}`, ...(report.dryRun ? [] : [`packs rebuilt ${report.packsRebuilt}${scrubbed}`])]
}

/** Like purge's dry run: what a save would expire now, and how to go ahead. */
export function previewLines(preview: RetentionPreview): string[] {
  const tables = RETENTION_TABLES.map((table) => `${table} ${preview.tables[table].rows} (${formatBytes(preview.tables[table].bytes)})`)
  return [
    ...retentionLines(preview.settings, null),
    `preview, nothing saved; saving now would expire: ${tables.join(', ')}`,
    'run again with --yes to save and apply',
  ]
}

function retentionPlan(args: Extract<DataArgs, { command: 'retention' }>): Planned {
  if (args.change === null) return { method: 'GET', path: '/data/retention', lines: (body) => retentionLines(body as DataSettings, null) }
  // Only an explicit --yes saves; anything else is a preview.
  if (args.apply !== true) {
    return { method: 'PUT', path: '/data/retention', body: { ...args.change, preview: true }, lines: (body) => previewLines((body as { preview: RetentionPreview }).preview) }
  }
  return {
    method: 'PUT',
    path: '/data/retention',
    body: args.change,
    lines: (body) => {
      const answer = body as { saved: DataSettings; applied: RetentionOutcome }
      return retentionLines(answer.saved, answer.applied)
    },
  }
}

function findingsPlan(args: Extract<DataArgs, { command: 'findings' }>): Planned {
  if (args.resolve === null) {
    return { method: 'GET', path: `/data/findings?action=${args.all ? 'all' : 'pending'}`, lines: (body) => findingsLines(body as FindingsView) }
  }
  return {
    method: 'POST',
    path: `/data/findings/${args.resolve.id}/resolve`,
    body: { action: args.resolve.action },
    lines: (body) => [`finding resolved: ${findingLine((body as { resolved: Finding }).resolved)}`],
  }
}

/** Which route each command calls; exported so tests can check the mapping without a daemon. */
export function planFor(args: DataArgs): Planned {
  switch (args.command) {
    case 'size':
      return { method: 'GET', path: '/data/size', lines: (body) => sizeLines(body as SizeReport) }
    case 'scan':
      return { method: 'POST', path: '/data/scan', body: {}, lines: (body) => scanLines(body as ScanResult) }
    case 'retention':
      return retentionPlan(args)
    case 'findings':
      return findingsPlan(args)
    case 'purge':
      return { method: 'POST', path: '/data/purge', body: args.body, lines: (body) => purgeLines(body as PurgeReport) }
  }
}

export async function runDataCommand(env: DataCliEnv, args: DataArgs): Promise<number> {
  const plan = planFor(args)
  const answer = await call(env, plan.method, plan.path, plan.body)
  if (!answer.ok) {
    env.out(`kinfold ${args.command} failed: ${answer.error}`)
    return EXIT_FAILED
  }
  for (const line of plan.lines(answer.body)) env.out(line)
  return EXIT_OK
}
