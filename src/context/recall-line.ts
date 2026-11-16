// What the user sees of a recall: one line after a prompt and a short list at
// session start. Both are built from the observation ids an answer carried, so
// they describe what the model was sent and nothing else; titles and the
// header only decorate those ids. A title is another agent's text, so it is
// cleaned before it reaches a terminal: no line break, no control or
// direction-override character. Pure, with no imports: the hook, the OpenCode
// plugin and `kinfold watch` all load it.

/** One memory an answer carried on the prompt channel, and which half sent it. */
export interface Recalled {
  id: number
  title: string
  /** `related` matched the prompt; `new` was written by another session since this one last received memory. */
  part: 'related' | 'new'
}

/** The header of the session-start list and the newest memories of the pack. */
export interface FirstScreen {
  project: string
  /** Memories stored for the project, current or not. */
  total: number
  /** When another session last worked in the project; null for the first. */
  lastSessionAt: number | null
  rows: { id: number; title: string; occurredAt: number }[]
}

export const FIRST_SCREEN_ROWS = 8
/** Memories named on the line before it counts the rest. */
export const LINE_TITLES = 5
const LINE_TITLE_CHARS = 40
const LIST_TITLE_CHARS = 60
/** A toast box is narrow (about 56 columns in OpenCode 2.2.5), and a row that wraps reads badly. */
const TOAST_TITLE_CHARS = 34

export const NOTHING_RECALLED_LINE = 'kinfold · nothing recalled'
export const HELD_OUT_LINE = 'kinfold · recall held out for this prompt (impact test)'
export const DAEMON_DOWN_LINE = 'kinfold · daemon not running; this prompt is saved and will be captured when it starts'
export const DAEMON_DOWN_START_LINE = 'kinfold · daemon not running; this session is saved and will be captured when it starts'
/** The daemon answered late, refused or sent something unusable, so nothing was added to the prompt. */
export const NO_ANSWER_LINE = 'kinfold · no answer in time; nothing recalled'
export const NO_ANSWER_START_LINE = 'kinfold · no answer in time; no memory sent for this session yet'
/** For an agent whose hooks hand the model nothing on a prompt. */
export const NO_PROMPT_MEMORY_LINE = 'kinfold · nothing recalled · this agent takes no memory on a prompt'

const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g

/** One line of plain text: control and direction characters become spaces, runs of space collapse. */
export function cleanTitle(text: string): string {
  return text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()
}

function cut(text: string, max: number): string {
  const clean = cleanTitle(text)
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

function parts(ids: readonly number[], byId: ReadonlyMap<number, Recalled>): string {
  const fresh = ids.filter((id) => byId.get(id)?.part === 'new').length
  if (fresh === 0) return ''
  const related = ids.length - fresh
  return related === 0 ? ' (new from other sessions)' : ` (${related} related, ${fresh} new from other sessions)`
}

/**
 * The line for one prompt. `ids` is what the answer carried, in order;
 * `recalled` only supplies titles and parts for those ids, so an entry for an
 * id that was not sent is ignored and an id with no entry shows as its number.
 */
export function recallLine(ids: readonly number[], recalled: readonly Recalled[]): string {
  if (ids.length === 0) return NOTHING_RECALLED_LINE
  const byId = new Map(recalled.map((entry) => [entry.id, entry]))
  const named = ids.slice(0, LINE_TITLES).map((id) => {
    const title = cut(byId.get(id)?.title ?? '', LINE_TITLE_CHARS)
    return title === '' ? `#${id}` : `#${id} ${title}`
  })
  const rest = ids.length - named.length
  return [`kinfold · recalled ${ids.length}${parts(ids, byId)}`, ...named, ...(rest > 0 ? [`+${rest} more`] : [])].join(' · ')
}

/** Memory read straight from the store because no daemon was listening: say both, so the line still means what was sent. */
export function daemonDownWith(line: string): string {
  return line.replace(/^kinfold · /, 'kinfold · daemon not running, read from the store · ')
}

/** The ids a line names, in order; tests hold a line to the ids that were sent with it. */
export function idsInLine(line: string): number[] {
  return [...line.matchAll(/#(\d+)/g)].map((match) => Number(match[1]))
}

/** "2h", "1d": the same short ages the pack uses, floored. */
export function shortAge(from: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - from) / 60_000))
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

const count = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/**
 * The list on one line, for an agent whose user channel is known to show one:
 * the header and how many memories the session's context holds. `ids` is what
 * the pack carried, as for the list.
 */
export function firstScreenLine(screen: FirstScreen | null, ids: readonly number[]): string {
  if (screen === null) return firstScreenList(null, ids, 0)
  const project = cut(screen.project, 60)
  if (screen.total === 0) return `kinfold · ${project} · no memories yet`
  return `kinfold · ${project} · ${count(screen.total, 'memory', 'memories')} · ${ids.length === 0 ? 'none' : ids.length.toLocaleString('en-US')} in this session's context`
}

export interface FirstScreenOptions {
  /** False for an agent that drops what a hook prints at session start, so its model got no pack. */
  takesPack?: boolean
}

/**
 * The session-start list: a header, then at most FIRST_SCREEN_ROWS of the
 * newest memories among `ids` (the pack's), then how many more the pack holds.
 * `screen` is null when the answer came without a header (an older daemon, or
 * the stored pack read while the daemon is down).
 */
export function firstScreenList(screen: FirstScreen | null, ids: readonly number[], now: number, options: FirstScreenOptions = {}): string {
  if (screen === null) {
    return ids.length === 0 ? 'kinfold · no memories yet' : `kinfold · ${count(ids.length, 'memory', 'memories')} in this session's context · kinfold dashboard`
  }
  const project = cut(screen.project, 60)
  if (screen.total === 0) return `kinfold · ${project} · no memories yet`
  const last = screen.lastSessionAt === null ? '' : ` · last session ${shortAge(screen.lastSessionAt, now)} ago`
  const header = `kinfold · ${project} · ${count(screen.total, 'memory', 'memories')}${last}`
  if (options.takesPack === false) return `${header}\n  no memory is sent at session start on this agent · kinfold dashboard`
  const sent = new Set(ids)
  const rows = screen.rows.filter((row) => sent.has(row.id)).slice(0, FIRST_SCREEN_ROWS)
    .map((row) => ({ id: `#${row.id}`, title: cut(row.title, LIST_TITLE_CHARS), age: `(${shortAge(row.occurredAt, now)})` }))
  const idWidth = Math.max(0, ...rows.map((row) => row.id.length))
  const titleWidth = Math.max(0, ...rows.map((row) => row.title.length))
  const lines = rows.map((row) => `  ${row.id.padEnd(idWidth)}  ${row.title.padEnd(titleWidth)}  ${row.age}`)
  const more = ids.length - rows.length
  return [header, ...lines, ...(more > 0 ? [`  … ${more.toLocaleString('en-US')} more in this session's context · kinfold dashboard`] : [])].join('\n')
}

/**
 * The session-start list for a toast: the same header, rows and count as
 * firstScreenList, with each row short and unpadded so it fits a narrow box
 * on one line.
 */
export function firstScreenToast(screen: FirstScreen | null, ids: readonly number[], now: number): string {
  if (screen === null || screen.total === 0) return firstScreenList(screen, ids, now)
  const [header = ''] = firstScreenList({ ...screen, rows: [] }, [], now).split('\n')
  const sent = new Set(ids)
  const rows = screen.rows.filter((row) => sent.has(row.id)).slice(0, FIRST_SCREEN_ROWS)
  const lines = rows.map((row) => `  #${row.id} ${cut(row.title, TOAST_TITLE_CHARS)} (${shortAge(row.occurredAt, now)})`)
  const more = ids.length - rows.length
  return [header, ...lines, ...(more > 0 ? [`  … ${more.toLocaleString('en-US')} more · kinfold dashboard`] : [])].join('\n')
}
