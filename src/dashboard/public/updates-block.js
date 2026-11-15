// The Updates block on the data page: whether patch releases install
// themselves, the switch for it (PUT /update/auto), the last release that
// installed itself and the last attempt that failed. The switch is shown only
// where it decides: when auto-update is off because the update check is off or
// an environment variable says so, the reason is shown and no button.

import { api, errorText } from './api.js'
import { h, notice, replaceContent } from './dom.js'

/**
 * @typedef {object} AutoUpdate
 * @property {boolean} on
 * @property {string | null} reason why it is off; null when on
 * @property {{ version: string, at: number, reason: string, blocked?: true } | null} lastError a blocker is not retried daily
 * @property {{ version: string, previous: string, at: number } | null} lastUpdate
 */

/** The reason the switch itself set; any other reason is outside its reach. */
const SWITCHED_OFF = 'turned off'

/** @param {number} at */
const day = (at) => new Date(at).toISOString().slice(0, 10)

/** @param {unknown} value @returns {AutoUpdate | null} */
export function autoUpdateOf(value) {
  if (value === null || typeof value !== 'object' || !('on' in value) || typeof value.on !== 'boolean') return null
  return /** @type {AutoUpdate} */ (value)
}

/**
 * @param {AutoUpdate} auto
 * @param {(enabled: boolean) => void} onSwitch
 */
function stateLines(auto, onSwitch) {
  const canSwitch = auto.on || auto.reason === SWITCHED_OFF
  const off = auto.reason === null || auto.reason === SWITCHED_OFF ? 'Patch releases are not installed automatically.' : `Patch releases are not installed automatically: ${auto.reason}.`
  return [
    h('p', { class: 'figure' }, h('span', { class: auto.on ? 'badge run-ok' : 'badge' }, auto.on ? 'on' : 'off'), ' ', auto.on ? 'Patch releases install themselves.' : off),
    canSwitch && h('div', { class: 'actions' }, h('button', { type: 'button', class: auto.on ? 'quiet' : 'primary', onclick: () => onSwitch(!auto.on) }, auto.on ? 'Turn off' : 'Turn on')),
    auto.lastUpdate !== null && h('p', { class: 'hint' }, `Last update: ${auto.lastUpdate.version} (was ${auto.lastUpdate.previous}) on ${day(auto.lastUpdate.at)}.`),
    auto.lastError !== null && notice(`Last error: ${auto.lastError.version} on ${day(auto.lastError.at)}: ${auto.lastError.reason}. ${auto.lastError.blocked === true ? 'It is tried again when the daemon restarts or the install changes.' : 'It is tried again after the next daily check.'}`, 'error'),
  ]
}

/**
 * @param {AutoUpdate | null} auto what GET /update/auto reported; null when the daemon reported nothing
 * @param {{ send: (method: string, path: string, body: unknown) => Promise<unknown> }} [deps]
 */
export function updatesBlock(auto, deps = { send: api }) {
  const body = h('div', {})
  const status = h('div', { 'aria-live': 'polite' })
  /** @param {AutoUpdate} current */
  const show = (current) => {
    replaceContent(body, ...stateLines(current, (enabled) => {
      replaceContent(status)
      deps.send('PUT', '/update/auto', { enabled }).then(
        (answer) => {
          const next = autoUpdateOf(answer !== null && typeof answer === 'object' && 'auto' in answer ? answer.auto : null)
          if (next !== null) show(next)
        },
        (error) => replaceContent(status, notice(errorText(error), 'error')))
    }))
  }
  if (auto === null) replaceContent(body, h('p', { class: 'hint' }, 'This daemon does not report its update settings.'))
  else show(auto)
  return h('section', { class: 'block', 'aria-label': 'Updates' },
    h('h2', { class: 'block-title' }, h('span', { class: 'kicker' }, 'E'), ' ', 'Updates'),
    h('p', { class: 'hint' }, 'A patch release, such as 0.2.0 to 0.2.1, is installed once no agent has been active for ten minutes. Larger releases wait for kinfold update.'),
    body, status)
}

/** The block for the page, from the daemon; a failed read still renders, without the switch. */
export async function loadUpdatesBlock() {
  try {
    const answer = await api('GET', '/update/auto')
    return updatesBlock(autoUpdateOf(answer !== null && typeof answer === 'object' && 'auto' in answer ? answer.auto : null))
  } catch {
    return updatesBlock(null)
  }
}
