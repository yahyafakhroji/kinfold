// Sessions: what was said, in plain text. The list shows sessions newest
// first (#sessions, with ?host= and ?before= for the next page); opening one
// (#sessions?id=7) walks its turns in order: the prompt, what Kinfold recalled
// for it, the agent's reply, and what was saved from it. The AI summary is
// side detail, folded away. Prompt and reply are the stored text, which is
// after the secret scan, so a secret shows as its redaction marker.
// Every stored value is rendered as text through dom.js; nothing is parsed.

import { api, errorText } from './api.js'
import { h, notice, replaceContent, table } from './dom.js'
import { formatHash } from './hash.js'

/** A reply longer than this is cut, with "show all". */
export const REPLY_PREVIEW_CHARS = 600

/**
 * HH:MM in the reader's time zone.
 * @param {number} at
 */
export function clockTime(at) {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * YYYY-MM-DD HH:MM in the reader's time zone, like the turn times.
 * @param {number} at
 */
export function localTime(at) {
  const date = new Date(at)
  const two = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${clockTime(at)}`
}

/** The reader's zone as the browser names it (Europe/Berlin), said once per view so every time on it reads as local. */
export function timeZoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'
  } catch {
    return 'local time'
  }
}

/** @param {number} n @param {string} one @param {string} many */
const counted = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/**
 * One line of a turn: who, then what.
 * @param {string} who
 * @param {...import('./dom.js').Child} what
 */
const line = (who, ...what) => h('div', { class: 'turn-line' }, h('span', { class: 'turn-who' }, who), h('div', { class: 'turn-what' }, ...what))

/**
 * Memories by id and title, each a link into the memory browser.
 * @param {{ id: number, title: string }[]} items
 */
const memoryLinks = (items) => h('ul', { class: 'turn-memories' }, items.map((item) => h('li', {},
  h('a', { class: 'mono', href: formatHash({ page: 'memory', params: { id: String(item.id) } }) }, `#${item.id}`), ' ', item.title)))

/**
 * Text that may be long: cut to a preview, with a button that opens and closes it.
 * @param {string} text
 */
function foldable(text) {
  const body = h('p', { class: 'turn-text' }, text.length > REPLY_PREVIEW_CHARS ? `${text.slice(0, REPLY_PREVIEW_CHARS)}…` : text)
  if (text.length <= REPLY_PREVIEW_CHARS) return [body]
  let open = false
  const button = h('button', { type: 'button', class: 'quiet', 'aria-expanded': 'false' }, 'show all')
  button.addEventListener('click', () => {
    open = !open
    replaceContent(body, open ? text : `${text.slice(0, REPLY_PREVIEW_CHARS)}…`)
    replaceContent(button, open ? 'show less' : 'show all')
    button.setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  return [body, button]
}

/** @param {import('../../store/session-reads').TurnSummary} summary */
function summaryDetail(summary) {
  const parts = [['Request', summary.request], ['Learned', summary.learned], ['Completed', summary.completed], ['Next steps', summary.nextSteps]]
    .filter(([, value]) => value !== null && value !== '')
  return h('details', { class: 'turn-side' }, h('summary', {}, 'AI summary of this turn'),
    h('dl', { class: 'turn-summary' }, parts.map(([label, value]) => [h('dt', {}, label), h('dd', {}, value)])))
}

/**
 * One turn. Prompt, reply and titles are stored text and become text nodes.
 * @param {import('../../store/session-reads').SessionTurn} turn
 */
export function turnItem(turn) {
  const gone = h('p', { class: 'empty' }, 'removed by retention')
  const recalled = turn.heldOut
    ? h('p', { class: 'hint' }, 'recall held out for this prompt (impact test)')
    : turn.recalled.length > 0 ? (turn.late === true
      ? [memoryLinks(turn.recalled), h('p', { class: 'hint' }, 'found too late for the agent to show; not counted as sent, so new memory comes again with the next prompt')]
      : memoryLinks(turn.recalled))
      : h('p', { class: 'hint' }, turn.recallKnown === false ? 'not recorded for turns from before this version' : 'nothing recalled')
  const reply = turn.expired ? [gone] : turn.reply === null ? [h('p', { class: 'hint' }, 'no reply captured')] : foldable(turn.reply)
  return h('li', { class: 'turn' },
    h('span', { class: 'turn-time mono' }, clockTime(turn.at)),
    h('div', { class: 'turn-body' },
      line('you', turn.expired ? h('p', { class: 'empty' }, 'removed by retention') : h('p', { class: 'turn-text' }, turn.prompt)),
      line('recalled', recalled),
      line('agent', ...reply),
      turn.saved.length > 0 && line('saved', memoryLinks(turn.saved)),
      turn.summary !== null && summaryDetail(turn.summary)))
}

/**
 * @param {import('../../store/session-reads').SessionList} answer
 * @param {import('./hash.js').HashState} state
 */
export function sessionsList(answer, state) {
  const host = state.params.host ?? ''
  const older = answer.nextBefore === null ? null : h('p', { class: 'actions' },
    h('a', { class: 'badge quiet', href: formatHash({ page: 'sessions', params: { before: String(answer.nextBefore), host } }) }, 'Older sessions'))
  return h('section', { class: 'block', 'aria-label': 'Sessions' },
    table('Sessions', [`Started (${timeZoneName()})`, 'Agent', 'Project', 'Prompts', ''], answer.sessions.map((row) => [
      h('span', { class: 'mono' }, localTime(row.startedAt)), h('span', { class: 'host' }, row.host), row.project, String(row.prompts),
      h('a', { href: formatHash({ page: 'sessions', params: { id: String(row.id) } }) }, 'open')]), 'No sessions recorded yet.'),
    older)
}

/**
 * One session: its header, its turns, and a button for the next page of a long one.
 * @param {import('../../store/session-reads').SessionDetail} detail
 * @param {import('./hash.js').HashState} _state
 */
export function sessionView(detail, _state) {
  const { session } = detail
  const turns = h('ol', { class: 'turns' }, detail.turns.map(turnItem))
  const status = h('div', { 'aria-live': 'polite' })
  const more = h('div', { class: 'actions' })
  /** @param {number | null} after */
  const offer = (after) => {
    replaceContent(more)
    if (after === null) return
    const button = h('button', { type: 'button', class: 'quiet' }, 'Load more turns')
    button.addEventListener('click', () => {
      button.setAttribute('disabled', '')
      api('GET', `/memory/sessions/${session.id}/turns?after=${after}`).then(
        (next) => {
          for (const turn of next.turns) turns.appendChild(turnItem(turn))
          offer(next.nextAfter)
        },
        (error) => {
          button.removeAttribute('disabled')
          replaceContent(status, notice(errorText(error), 'error'))
        })
    })
    more.appendChild(button)
  }
  offer(detail.nextAfter)
  const start = session.startMemories === 0 ? 'no memory in its context at the start' : `${counted(session.startMemories, 'memory', 'memories')} in its context at the start`
  return h('section', { class: 'block', 'aria-label': 'Session' },
    h('p', {}, h('a', { href: formatHash({ page: 'sessions', params: {} }) }, 'All sessions')),
    h('h2', { class: 'block-title' }, h('span', { class: 'host' }, session.host), ' ', session.project),
    h('p', { class: 'hint' }, `Started ${localTime(session.startedAt)} (${timeZoneName()}) · ${counted(session.prompts, 'prompt', 'prompts')} · ${start}.`),
    detail.turns.length === 0 ? h('p', { class: 'empty' }, 'No prompts in this session.') : turns,
    more, status)
}

/** @param {import('./hash.js').HashState} state */
function listPath(state) {
  const query = new URLSearchParams(['before', 'host', 'project'].filter((key) => (state.params[key] ?? '') !== '').map((key) => [key, state.params[key] ?? '']))
  const text = query.toString()
  return `/memory/sessions${text === '' ? '' : `?${text}`}`
}

/** @param {import('./hash.js').HashState} [state] */
export async function renderSessions(state = { page: 'sessions', params: {} }) {
  const id = /^\d{1,15}$/.test(state.params.id ?? '') ? state.params.id : null
  const body = id === null
    ? sessionsList(await api('GET', listPath(state)), state)
    : sessionView(await api('GET', `/memory/sessions/${id}/turns`), state)
  return h('section', { class: 'page', 'aria-labelledby': 'page-title' },
    h('header', { class: 'page-head' }, h('p', { class: 'kicker' }, '02'), h('h1', { id: 'page-title' }, 'Sessions'),
      h('p', { class: 'lede' }, 'Your prompts and the agents\' replies as they were, with what Kinfold recalled for each.')),
    body)
}
