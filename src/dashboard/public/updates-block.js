// The Updates block on the data page: the updates level (off, tell me, or
// patch releases installed with larger ones downloaded for a yes), the beta
// channel, whether patch releases install themselves here and why not, the
// last release that installed itself and the last attempt that failed. A
// choice is saved with PUT /update/settings, then the block shows what the
// daemon reports, since an environment variable can still keep auto-update off.

import { api, errorText } from './api.js'
import { h, notice, replaceContent } from './dom.js'

/**
 * @typedef {object} AutoUpdate
 * @property {boolean} on
 * @property {string | null} reason why it is off; null when on
 * @property {{ version: string, at: number, reason: string, blocked?: true } | null} lastError a blocker is not retried daily
 * @property {{ version: string, previous: string, at: number } | null} lastUpdate
 */

/**
 * @typedef {object} UpdateSettings
 * @property {'off' | 'notify' | 'patch'} level
 * @property {boolean} beta
 */

/** The reasons the level itself sets; any other reason is outside its reach. */
const LEVEL_REASONS = new Set(['turned off'])

/** @type {readonly [UpdateSettings['level'], string][]} */
const LEVELS = [['off', 'Off'], ['notify', 'Tell me'], ['patch', 'Patch and offer larger releases']]

/** @param {number} at */
const day = (at) => new Date(at).toISOString().slice(0, 10)

/** @param {unknown} value @returns {AutoUpdate | null} */
export function autoUpdateOf(value) {
  if (value === null || typeof value !== 'object' || !('on' in value) || typeof value.on !== 'boolean') return null
  return /** @type {AutoUpdate} */ (value)
}

/** @param {unknown} value @returns {UpdateSettings | null} */
export function settingsOf(value) {
  if (value === null || typeof value !== 'object' || !('level' in value) || !('beta' in value)) return null
  const { level, beta } = /** @type {Record<string, unknown>} */ (value)
  return (level === 'off' || level === 'notify' || level === 'patch') && typeof beta === 'boolean' ? { level, beta } : null
}

/** @param {AutoUpdate} auto */
function stateLines(auto) {
  const off = auto.reason === null || LEVEL_REASONS.has(auto.reason) ? 'Patch releases are not installed automatically.' : `Patch releases are not installed automatically: ${auto.reason}.`
  return [
    h('p', { class: 'figure' }, h('span', { class: auto.on ? 'badge run-ok' : 'badge' }, auto.on ? 'on' : 'off'), ' ', auto.on ? 'Patch releases install themselves.' : off),
    auto.lastUpdate !== null && h('p', { class: 'hint' }, `Last update: ${auto.lastUpdate.version} (was ${auto.lastUpdate.previous}) on ${day(auto.lastUpdate.at)}.`),
    auto.lastError !== null && notice(`Last error: ${auto.lastError.version} on ${day(auto.lastError.at)}: ${auto.lastError.reason}. ${auto.lastError.blocked === true ? 'It is tried again when the daemon restarts or the install changes.' : 'It is tried again after the next daily check.'}`, 'error'),
  ]
}

/**
 * @param {UpdateSettings} settings
 * @param {(next: UpdateSettings) => void} onChoose
 */
function choiceButtons(settings, onChoose) {
  return h('div', { class: 'actions' },
    ...LEVELS.map(([level, label]) => h('button', { type: 'button', class: settings.level === level ? 'primary' : 'quiet', 'aria-pressed': settings.level === level ? 'true' : 'false', onclick: () => onChoose({ ...settings, level }) }, label)),
    h('button', { type: 'button', class: 'quiet', onclick: () => onChoose({ ...settings, beta: !settings.beta }) }, settings.beta ? 'Stop offering beta releases' : 'Offer beta releases'))
}

/**
 * @param {AutoUpdate | null} auto what GET /update/auto reported; null when the daemon reported nothing
 * @param {UpdateSettings | null} settings what GET /update/settings reported; null when it reported nothing
 * @param {{ send: (method: string, path: string, body?: unknown) => Promise<unknown> }} [deps]
 */
export function updatesBlock(auto, settings, deps = { send: api }) {
  const body = h('div', {})
  const status = h('div', { 'aria-live': 'polite' })
  /** @param {AutoUpdate | null} currentAuto @param {UpdateSettings | null} current */
  const show = (currentAuto, current) => {
    if (currentAuto === null && current === null) {
      replaceContent(body, h('p', { class: 'hint' }, 'This daemon does not report its update settings.'))
      return
    }
    replaceContent(body,
      ...(currentAuto === null ? [] : stateLines(currentAuto)),
      current !== null && h('p', { class: 'hint' }, current.beta ? 'Beta releases are offered too, each waiting for your yes.' : 'Beta releases are not offered.'),
      current !== null && choiceButtons(current, (next) => {
        replaceContent(status)
        deps.send('PUT', '/update/settings', next)
          .then(async (answer) => {
            const saved = settingsOf(answer !== null && typeof answer === 'object' && 'settings' in answer ? answer.settings : null) ?? next
            const read = await deps.send('GET', '/update/auto').catch(() => null)
            show(autoUpdateOf(read !== null && typeof read === 'object' && 'auto' in read ? read.auto : null) ?? currentAuto, saved)
          })
          .catch((error) => replaceContent(status, notice(errorText(error), 'error')))
      }))
  }
  show(auto, settings)
  return h('section', { class: 'block', 'aria-label': 'Updates' },
    h('h2', { class: 'block-title' }, h('span', { class: 'kicker' }, 'E'), ' ', 'Updates'),
    h('p', { class: 'hint' }, 'A patch release, such as 0.2.0 to 0.2.1, is installed once no agent has been active for ten minutes. A larger release is downloaded and waits for kinfold update or the Install button.'),
    body, status)
}

/** The block for the page, from the daemon; a failed read still renders, without the choices. */
export async function loadUpdatesBlock() {
  const [auto, settings] = await Promise.all([
    api('GET', '/update/auto').catch(() => null),
    api('GET', '/update/settings').catch(() => null),
  ])
  return updatesBlock(
    autoUpdateOf(auto !== null && typeof auto === 'object' && 'auto' in auto ? auto.auto : null),
    settingsOf(settings !== null && typeof settings === 'object' && 'settings' in settings ? settings.settings : null))
}
