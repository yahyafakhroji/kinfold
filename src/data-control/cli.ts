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
import type { Mark, Row } from '../install/prompt/prompts'
import { type DataSettings, RETENTION_TABLES } from '../store/data-settings-store'
import type { Finding } from '../store/findings-store'
import type { PurgeReport } from './purge'
import type { RetentionOutcome, RetentionPreview } from './retention'
import type { ScanResult } from './scanner'
import { type SizeReport, formatBytes } from './size'

export type DataCliEnv = Pick<InstallEnv, 'dataDir' | 'fetch' | 'out' | 'ui'>

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
  /** The section's heading on a terminal. */
  title: string
  /** The command to run next, when the answer calls for one; a terminal run ends on it. */
  next?: (body: unknown) => string | null
}

const RUN_AGAIN = 'run again with --yes to save and apply'

/** A row worth a look: a size over its threshold, a finding still pending. */
const rowMark = (line: string): Mark => (/: OVER$|^warning: |^#\d+ .* pending$/.test(line) ? 'warn' : line === 'no findings' ? 'ok' : 'none')

/** A marked row stands at the margin; an unmarked one keeps its indent, so the rows under a heading read as a list. */
export function rowOf(line: string): Row {
  const mark = rowMark(line.trim())
  return { mark, text: mark === 'none' ? line.trimEnd() : line.trim() }
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

function sizeLines(report: Omit<SizeReport, 'parts' | 'warning'> & Partial<Pick<SizeReport, 'parts' | 'warning'>>): string[] {
  const { files } = report
  return [
    `database ${formatBytes(report.totalBytes)} (db ${formatBytes(files.db)}, wal ${formatBytes(files.wal)}, shm ${formatBytes(files.shm)}); free pages ${formatBytes(report.freeBytes)}`,
    `warning threshold ${formatBytes(report.warnBytes)}: ${report.overWarn ? 'OVER' : 'ok'}`,
    ...(report.overWarn && report.warning != null ? [`warning: ${report.warning}`] : []),
    // A daemon from before the part breakdown answers without parts until it restarts.
    ...(report.parts === undefined ? [] : ['by part:', ...report.parts.map((part) => `  ${part.name} ${formatBytes(part.bytes)} (${report.totalBytes === 0 ? 0 : Math.round((part.bytes / report.totalBytes) * 100)}%)`)]),
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
    RUN_AGAIN,
  ]
}

function retentionPlan(args: Extract<DataArgs, { command: 'retention' }>): Planned {
  if (args.change === null) return { method: 'GET', path: '/data/retention', title: 'Retention', lines: (body) => retentionLines(body as DataSettings, null) }
  // Only an explicit --yes saves; anything else is a preview.
  if (args.apply !== true) {
    return { method: 'PUT', path: '/data/retention', title: 'Retention', body: { ...args.change, preview: true }, lines: (body) => previewLines((body as { preview: RetentionPreview }).preview), next: () => 'Save and apply it with: kinfold retention --set ... --yes' }
  }
  return {
    method: 'PUT',
    path: '/data/retention',
    title: 'Retention',
    body: args.change,
    lines: (body) => {
      const answer = body as { saved: DataSettings; applied: RetentionOutcome }
      return retentionLines(answer.saved, answer.applied)
    },
  }
}

function findingsPlan(args: Extract<DataArgs, { command: 'findings' }>): Planned {
  if (args.resolve === null) {
    return {
      method: 'GET',
      path: `/data/findings?action=${args.all ? 'all' : 'pending'}`,
      title: 'Findings',
      lines: (body) => findingsLines(body as FindingsView),
      next: (body) => (Object.keys((body as FindingsView).pendingByRule).length > 0 ? 'Resolve one with: kinfold findings --redact <id> or --purge <id>' : null),
    }
  }
  return {
    method: 'POST',
    path: `/data/findings/${args.resolve.id}/resolve`,
    title: 'Finding',
    body: { action: args.resolve.action },
    lines: (body) => [`finding resolved: ${findingLine((body as { resolved: Finding }).resolved)}`],
  }
}

/** Which route each command calls; exported so tests can check the mapping without a daemon. */
export function planFor(args: DataArgs): Planned {
  switch (args.command) {
    case 'size':
      return { method: 'GET', path: '/data/size', title: 'Database size', lines: (body) => sizeLines(body as SizeReport), next: (body) => ((body as SizeReport).overWarn ? 'Free space with: kinfold retention --set <table>=<days> --yes' : null) }
    case 'scan':
      return { method: 'POST', path: '/data/scan', title: 'Scan', body: {}, lines: (body) => scanLines(body as ScanResult), next: (body) => ((body as ScanResult).findings > 0 ? 'See them with: kinfold findings' : null) }
    case 'retention':
      return retentionPlan(args)
    case 'findings':
      return findingsPlan(args)
    case 'purge':
      return { method: 'POST', path: '/data/purge', title: 'Purge', body: args.body, lines: (body) => purgeLines(body as PurgeReport), next: (body) => ((body as PurgeReport).dryRun && Object.values((body as PurgeReport).counts).some((count) => count > 0) ? 'Remove them with the same command without --dry-run' : null) }
  }
}

export const PURGE_NEEDS_YES = 'kinfold purge: nothing was deleted. Purge asks before it deletes, and there is no terminal to ask on; pass --yes to delete, or --dry-run to see what would go'

/**
 * A purge cannot be undone, so it shows what would go and asks first, with no
 * as the answer Enter gives. Where no one can answer (a pipe, a script,
 * --plain) it deletes nothing and says how to go ahead, so a script never
 * deletes by an accident of where it ran.
 */
async function confirmedPurge(env: DataCliEnv, args: Extract<DataArgs, { command: 'purge' }>): Promise<number> {
  if (env.ui === undefined) {
    env.out(PURGE_NEEDS_YES)
    return EXIT_FAILED
  }
  const preview = await call(env, 'POST', '/data/purge', { ...args.body, dryRun: true })
  if (!preview.ok) {
    env.ui.error(`kinfold purge failed: ${preview.error}`)
    return EXIT_FAILED
  }
  const counts = Object.entries((preview.body as PurgeReport).counts).filter(([, count]) => count > 0).map(([table, count]) => `${table} ${count}`)
  if (counts.length === 0) {
    env.ui.section('Purge', [{ mark: 'none', text: 'nothing matches, so nothing was deleted' }])
    return EXIT_OK
  }
  env.ui.section('Purge', [{ mark: 'none', text: `would remove: ${counts.join(', ')}` }])
  if (!(await env.ui.confirm('Delete them? This cannot be undone.', false))) {
    env.out('nothing was deleted')
    return EXIT_OK
  }
  const answer = await call(env, 'POST', '/data/purge', args.body)
  if (!answer.ok) {
    env.ui.error(`kinfold purge failed: ${answer.error}`)
    return EXIT_FAILED
  }
  for (const line of purgeLines(answer.body as PurgeReport)) env.out(line)
  return EXIT_OK
}

export const FINDING_PURGE_NEEDS_YES = 'kinfold findings: nothing was deleted. --purge asks before it deletes, and there is no terminal to ask on; pass --yes to delete'

/**
 * Purging a finding deletes the stored row the secret was found in, which
 * cannot be undone, so it asks first like purge does. What is shown is the
 * finding as the list shows it: its id, where the row is and which rule
 * matched. A finding never holds the matched text, so the secret cannot
 * reach the screen.
 */
async function confirmedFindingPurge(env: DataCliEnv, id: number): Promise<number> {
  if (env.ui === undefined) {
    env.out(FINDING_PURGE_NEEDS_YES)
    return EXIT_FAILED
  }
  const listed = await call(env, 'GET', '/data/findings?action=pending')
  if (!listed.ok) {
    env.ui.error(`kinfold findings failed: ${listed.error}`)
    return EXIT_FAILED
  }
  const finding = (listed.body as FindingsView).findings.find((candidate) => candidate.id === id)
  if (finding === undefined) {
    env.ui.error(`kinfold findings: no pending finding #${id}; nothing was deleted`)
    return EXIT_FAILED
  }
  env.ui.section('Finding', [rowOf(findingLine(finding))])
  if (!(await env.ui.confirm(`Delete the ${finding.table} row this finding is in? This cannot be undone.`, false))) {
    env.out('nothing was deleted')
    return EXIT_OK
  }
  const answer = await call(env, 'POST', `/data/findings/${id}/resolve`, { action: 'purge' })
  if (!answer.ok) {
    env.ui.error(`kinfold findings failed: ${answer.error}`)
    return EXIT_FAILED
  }
  env.out(`finding resolved: ${findingLine((answer.body as { resolved: Finding }).resolved)}`)
  return EXIT_OK
}

export async function runDataCommand(env: DataCliEnv, args: DataArgs): Promise<number> {
  if (args.command === 'purge' && args.body.dryRun !== true && !args.yes) return confirmedPurge(env, args)
  if (args.command === 'findings' && args.resolve?.action === 'purge' && !args.yes) return confirmedFindingPurge(env, args.resolve.id)
  const plan = planFor(args)
  const answer = await call(env, plan.method, plan.path, plan.body)
  if (!answer.ok) {
    ;(env.ui?.error ?? env.out)(`kinfold ${args.command} failed: ${answer.error}`)
    return EXIT_FAILED
  }
  const lines = plan.lines(answer.body)
  if (env.ui === undefined) {
    for (const line of lines) env.out(line)
    return EXIT_OK
  }
  const next = plan.next?.(answer.body) ?? null
  // A line that only says how to go on is the run's last line there, not a row as well.
  const shown = next === null ? lines : lines.filter((line) => line !== RUN_AGAIN)
  env.ui.section(plan.title, shown.map(rowOf))
  if (next !== null) env.ui.next(next)
  return EXIT_OK
}
