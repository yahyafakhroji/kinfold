// How numbers, times, agents and saved-token figures read on the page. Every
// sentence a page shows about tokens saved comes from savedLabel(), so the
// measured and estimated figures are worded the same way everywhere.

import type { Measured, Saved } from './types'

const AGENTS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', 'kilo-code': 'Kilo Code', 'gemini-cli': 'Gemini CLI',
  'qwen-code': 'Qwen Code', 'factory-droid': 'Factory Droid', devin: 'Devin', cline: 'Cline', copilot: 'GitHub Copilot', antigravity: 'Antigravity',
  junie: 'Junie', kiro: 'Kiro', amp: 'Amp', 'kimi-code': 'Kimi Code', auggie: 'Auggie', goose: 'Goose', crush: 'Crush', zed: 'Zed', continue: 'Continue', warp: 'Warp',
}

export function agentName(host: string | null): string {
  if (host === null) return 'An agent'
  return AGENTS[host] ?? host
}

const numberFormat = new Intl.NumberFormat('en')

export function count(n: number): string {
  return numberFormat.format(n)
}

/** "1 memory", "3 memories". */
export function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${n === 1 ? one : many}`
}

/** Tokens rounded to what a reader can take in: 182,000 rather than 181,937. */
export function tokens(n: number): string {
  const size = Math.abs(n)
  const step = size >= 100_000 ? 1_000 : size >= 10_000 ? 100 : size >= 1_000 ? 10 : 1
  return count(Math.round(n / step) * step)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function ago(at: number, now: number = Date.now()): string {
  const gap = Math.max(0, now - at)
  if (gap < MINUTE) return 'just now'
  if (gap < HOUR) return `${Math.floor(gap / MINUTE)} min ago`
  if (gap < DAY) return `${plural(Math.floor(gap / HOUR), 'hour', 'hours')} ago`
  if (gap < 30 * DAY) return `${plural(Math.floor(gap / DAY), 'day', 'days')} ago`
  return dateOnly(at)
}

const timeFormat = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false })
const dateFormat = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' })
const shortDateFormat = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' })

export function dateOnly(at: number): string {
  return dateFormat.format(at)
}

/** "Today 09:12", "Yesterday 17:02", "3 Nov 14:20". */
export function when(at: number, now: number = Date.now()): string {
  const day = (time: number): number => Math.floor((time - new Date(time).getTimezoneOffset() * MINUTE) / DAY)
  const gap = day(now) - day(at)
  const clock = timeFormat.format(at)
  if (gap === 0) return `Today ${clock}`
  if (gap === 1) return `Yesterday ${clock}`
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  return `${sameYear ? shortDateFormat.format(at) : dateFormat.format(at)} ${clock}`
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export type Tone = 'good' | 'quiet' | 'bad'

export interface SavedLabel {
  /** The figure itself, or a short phrase where there is none. */
  text: string
  /** Where the figure comes from, shown beside it. */
  source: string
  tone: Tone
  /** The one sentence the info button shows. */
  explain: string
}

const MEASURED_EXPLAIN = 'Measured: Kinfold compared your turns that had memory with turns where the impact test held it back, and multiplied the typical difference by this session\'s prompts.'
const ESTIMATE_EXPLAIN = 'Estimate: what it cost to write the memories this session was given, less what it cost to read them. It is an upper bound until the impact test has measured your own turns.'

export function savedLabel(saved: Saved): SavedLabel {
  if (saved.kind === 'none') return { text: '—', source: 'no memory used', tone: 'quiet', explain: 'This session was not given any memory, so nothing could be saved.' }
  if (saved.kind === 'estimate') {
    return { text: `up to ~${tokens(saved.tokens)}`, source: saved.partial ? 'estimate, partial' : 'estimate', tone: 'quiet', explain: `${ESTIMATE_EXPLAIN}${saved.partial ? ' Some of the memories were written before Kinfold recorded what they cost, so they are left out.' : ''}` }
  }
  const turns = plural(saved.turnsCompared, 'turn', 'turns')
  if (saved.status === 'no-difference') return { text: 'No measurable saving yet', source: `measured, ${turns} compared`, tone: 'quiet', explain: `${MEASURED_EXPLAIN} So far the difference is within normal variation.` }
  if (saved.status === 'cost') return { text: `Cost ~${tokens(Math.abs(saved.tokens ?? 0))} more`, source: `measured, ${turns} compared`, tone: 'bad', explain: `${MEASURED_EXPLAIN} For this agent, turns with memory have used more tokens.` }
  return { text: `~${tokens(saved.tokens ?? 0)}`, source: `measured, ${turns} compared`, tone: 'good', explain: MEASURED_EXPLAIN }
}

/** The plain sentence for one agent's impact test result. */
export function measuredSentence(host: string, result: Measured): string {
  const agent = agentName(host)
  if (result.status === 'not-enough') {
    return `${agent}: not enough turns yet. The test needs ${result.minSample} turns with memory and ${result.minSample} without; it has ${count(result.normal)} and ${count(result.heldOut)}.`
  }
  const compared = `${count(result.heldOut + result.normal)} turns compared`
  if (result.status === 'no-difference') return `${agent}: no measurable saving yet (${compared}; the difference is within normal variation).`
  if (result.status === 'cost') return `${agent}: memory cost about ${tokens(-result.perTurn)} more tokens per turn (measured, ${compared}).`
  return `${agent}: memory saved about ${tokens(result.perTurn)} tokens per turn (measured, ${compared}).`
}

const DEVICE_LOCAL = 'local'

/** A session's device as a person names it. */
export function deviceName(device: string | null, names: ReadonlyMap<string, string>, hubName: string | null = null, recordedSince: number | null = null): string {
  if (device === null) return recordedSince === null ? 'Not recorded' : `Not recorded before ${dateOnly(recordedSince)}`
  if (device === DEVICE_LOCAL) return hubName ?? 'This computer'
  return names.get(device) ?? device
}
