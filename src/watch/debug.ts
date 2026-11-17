// How `kinfold watch --debug` prints the daemon's trace: one block per event,
// a heading line with the time, agent and project, then indented detail.
// Every title and name is another session's or another machine's text, so
// each goes through cleanTitle and stays on its own line.

import { cleanTitle } from '../context/recall-line'
import { isRecord } from '../contract/event'
import type { SearchTrace, TraceCandidate, TraceEvent, TracedRow } from '../debug/trace'

type Of<K extends TraceEvent['kind']> = Extract<TraceEvent, { kind: K }>

const PREFIX = 'kinfold · '
const LABEL_WIDTH = 10
const OUTCOME_WIDTH = 17

function clock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const count = (n: number): string => n.toLocaleString('en-US')
const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const labelled = (label: string, text: string): string => `  ${label.padEnd(LABEL_WIDTH)}${text}`
const withoutPrefix = (line: string): string => cleanTitle(line.startsWith(PREFIX) ? line.slice(PREFIX.length) : line)
const rowText = (row: TracedRow): string => `#${row.id} ${cleanTitle(row.title)}`

function heading(event: TraceEvent, what: string): string {
  return `${clock(event.at)}  ${cleanTitle(event.host)} · ${cleanTitle(event.project)} · ${what}`
}

/** The daemon's own time: it cannot see the hook's connection, so a hook that gave up early on a slow connection is not told apart. */
function hookLine(hook: Of<'prompt'>['hook']): string {
  if (hook.heldOut) return `held out for the impact test (daemon answered in ${hook.ms} ms)`
  if (hook.late) return `daemon answered in ${hook.ms} ms, after the ${hook.budgetMs} ms the hook waits: the hook used its fallback, and this is not counted as sent`
  return `daemon answered in ${hook.ms} ms; the hook waits ${hook.budgetMs} ms`
}

function candidateLine(candidate: TraceCandidate): string {
  const parts = [
    `#${candidate.id} ${cleanTitle(candidate.title)}`.trimEnd(),
    ...(candidate.distance !== null ? [`distance ${candidate.distance.toFixed(2)}`] : []),
    plural(candidate.matchedTerms, 'term'),
    candidate.source,
    ...(candidate.rule !== undefined ? [cleanTitle(candidate.rule)] : []),
  ]
  return `    ${candidate.outcome.padEnd(OUTCOME_WIDTH)}  ${parts.join(' · ')}`
}

function searchLines(search: SearchTrace | null): string[] {
  if (search === null) return [labelled('search', 'none')]
  const how = search.space !== null ? `embeddings ${cleanTitle(search.space)}` : search.semantic === 'ok' ? null : `meaning ${search.semantic}`
  const terms = search.terms.length === 0 ? 'no terms' : `terms ${search.terms.map(cleanTitle).join(', ')}`
  return [
    labelled('search', [search.mode, ...(how !== null ? [how] : []), terms].join(' · ')),
    ...(search.query !== '' ? [labelled('query', `"${cleanTitle(search.query)}"`)] : []),
    ...(search.candidates.length === 0 ? ['    no candidates'] : search.candidates.map(candidateLine)),
  ]
}

function promptLines(event: Of<'prompt'>): string[] {
  const sent = event.sent.ids.length === 0 ? 'nothing' : `${plural(event.sent.ids.length, 'memory', 'memories')}, ${count(event.sent.tokens)} tokens`
  return [
    heading(event, 'prompt'),
    labelled('hook', hookLine(event.hook)),
    ...searchLines(event.search),
    labelled('new', event.fresh.length === 0 ? 'none' : event.fresh.map(rowText).join(' · ')),
    labelled('sent', `${sent} · ${withoutPrefix(event.sent.line)}`),
  ]
}

function startLines(event: Of<'start'>): string[] {
  const pack = `${plural(event.rows.length, 'row')}, ${count(event.tokens)} tokens`
  return [heading(event, 'session start'), labelled('pack', [pack, ...event.rows.map(rowText)].join(' · '))]
}

function turnLines(event: Of<'turn'>): string[] {
  const usage = event.usage
  if (usage === null) return [heading(event, 'turn end'), labelled('usage', 'not readable from the transcript'), labelled('kinfold', `${count(event.kinfoldTokens)} tokens added to this prompt`)]
  const seconds = usage.durationMs === null ? [] : [`${(usage.durationMs / 1000).toFixed(1)} s`]
  const parts = [`input ${count(usage.inputTokens)}`, `cache read ${count(usage.cacheReadTokens)}`, ...(usage.cacheCreationTokens > 0 ? [`cache write ${count(usage.cacheCreationTokens)}`] : []),
    `output ${count(usage.outputTokens)}`, plural(usage.toolCalls, 'tool call'), ...seconds]
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
  const share = input > 0 ? ` (${((event.kinfoldTokens / input) * 100).toFixed(1)}% of the turn's input)` : ''
  return [heading(event, 'turn end'), labelled('usage', parts.join(' · ')), labelled('kinfold', `${count(event.kinfoldTokens)} tokens added to this prompt${share}`)]
}

function observerLine(event: Of<'observer'>): string {
  if (event.status === 'succeeded') return heading(event, `observer ran on ${plural(event.events, 'event')}, wrote ${event.written}`)
  if (event.status === 'skipped') return heading(event, `observer skipped ${plural(event.events, 'event')}`)
  return heading(event, `observer ${cleanTitle(event.status)}${event.events > 0 ? ` on ${plural(event.events, 'event')}` : ''}`)
}

export function formatDebugEvent(event: TraceEvent): string[] {
  if (event.kind === 'prompt') return promptLines(event)
  if (event.kind === 'start') return startLines(event)
  if (event.kind === 'turn') return turnLines(event)
  return event.note === undefined ? [observerLine(event)] : [observerLine(event), `  why       ${cleanTitle(event.note)}`]
}

const KINDS: ReadonlySet<string> = new Set(['prompt', 'start', 'turn', 'observer'])

/**
 * The fields every event has, checked; the rest is the daemon's own shape,
 * from the same build or a newer one. An event that fails the check is skipped,
 * and one that renders badly costs its own block, never the watch.
 */
export function parseDebugEvent(value: unknown): TraceEvent | null {
  if (!isRecord(value)) return null
  const { seq, at, host, project, kind } = value
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(at) || typeof host !== 'string' || typeof project !== 'string' || typeof kind !== 'string' || !KINDS.has(kind)) return null
  return value as unknown as TraceEvent
}

/** The block for an event, or one line saying it could not be shown. */
export function debugLines(event: TraceEvent): string[] {
  try {
    return formatDebugEvent(event)
  } catch {
    return [heading(event, `${cleanTitle(event.kind)} (this build cannot show it)`)]
  }
}
