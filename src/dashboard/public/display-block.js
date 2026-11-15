// The "What you see" block on the data page: two switches from
// GET /data/display, saved with PUT /data/display. One shows or hides what
// Kinfold recalled (the line after each prompt and the list at session start).
// The other is the opt-in impact test, which holds recall back on about one
// prompt in ten for the agents whose turn usage can be read, and says so on
// each one. Both take effect on the next prompt.

import { api, errorText } from './api.js'
import { h, notice, replaceContent } from './dom.js'

/**
 * @typedef {object} Display
 * @property {boolean} showRecall
 * @property {boolean} holdout
 * @property {string[]} holdoutHosts
 */

/** @param {unknown} value @returns {Display | null} */
export function displayOf(value) {
  if (value === null || typeof value !== 'object') return null
  const { showRecall, holdout, holdoutHosts } = /** @type {Record<string, unknown>} */ (value)
  if (typeof showRecall !== 'boolean' || typeof holdout !== 'boolean') return null
  return { showRecall, holdout, holdoutHosts: Array.isArray(holdoutHosts) ? holdoutHosts.filter((host) => typeof host === 'string') : [] }
}

/**
 * One switch: its state, what that state means, and the button that flips it.
 * @param {boolean} on
 * @param {string} whenOn
 * @param {string} whenOff
 * @param {string} name what the button names, for a screen reader
 * @param {() => void} flip
 */
function switchRow(on, whenOn, whenOff, name, flip) {
  return [
    h('p', { class: 'figure' }, h('span', { class: on ? 'badge run-ok' : 'badge' }, on ? 'on' : 'off'), ' ', on ? whenOn : whenOff),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: on ? 'quiet' : 'primary', 'aria-label': `${on ? 'Turn off' : 'Turn on'} ${name}`, onclick: flip }, on ? 'Turn off' : 'Turn on')),
  ]
}

/**
 * @param {Display | null} display what GET /data/display reported; null when the daemon reported nothing
 * @param {{ send: (method: string, path: string, body: unknown) => Promise<unknown> }} [deps]
 */
export function displayBlock(display, deps = { send: api }) {
  const body = h('div', {})
  const status = h('div', { 'aria-live': 'polite' })
  /** @param {Display} current */
  const show = (current) => {
    /** @param {{ showRecall?: boolean, holdout?: boolean }} change */
    const save = (change) => {
      replaceContent(status)
      deps.send('PUT', '/data/display', change).then(
        (answer) => {
          const next = displayOf(answer)
          if (next !== null) show(next)
        },
        (error) => replaceContent(status, notice(errorText(error), 'error')))
    }
    const agents = current.holdoutHosts.length === 0 ? 'the agents whose usage can be read' : current.holdoutHosts.join(', ')
    replaceContent(body,
      h('h3', { class: 'block-title' }, 'Recall line'),
      ...switchRow(current.showRecall,
        'Agents that can show a message say what Kinfold recalled after each prompt, and list the newest memories at session start.',
        'Agents show nothing about what Kinfold recalled. Memory still reaches the model as before.',
        'the recall line', () => save({ showRecall: !current.showRecall })),
      h('p', { class: 'hint' }, 'Shown to you only: the line and the list never enter the model\'s context. Agents with no message channel are covered by kinfold watch and the Sessions page.'),
      h('h3', { class: 'block-title' }, 'Impact test'),
      ...switchRow(current.holdout,
        `On for ${agents}. About 1 prompt in 10 goes without recalled memory, and the agent says so each time.`,
        'Off. Every prompt gets its recalled memory.',
        'the impact test', () => save({ holdout: !current.holdout })),
      h('p', { class: 'hint' }, `Opt-in. It measures what memory changes by comparing turns with and without it, on ${agents} only; every other agent keeps full recall. While it is on, the daemon reads token counts (nothing else) from the agent's transcript at the end of each turn. Results are on the Metrics page.`))
  }
  if (display === null) replaceContent(body, h('p', { class: 'hint' }, 'This daemon does not report these settings.'))
  else show(display)
  return h('section', { class: 'block', 'aria-label': 'What you see' },
    h('h2', { class: 'block-title' }, h('span', { class: 'kicker' }, 'F'), ' ', 'What you see'),
    body, status)
}

/** The block for the page, from the daemon; a failed read still renders, without the switches. */
export async function loadDisplayBlock() {
  try {
    return displayBlock(displayOf(await api('GET', '/data/display')))
  } catch {
    return displayBlock(null)
  }
}
