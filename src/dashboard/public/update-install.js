// The release on offer, under the update banner: its change lines with the
// breaking ones first, and, where the daemon staged it, the Install button.
// The install stops and restarts the daemon, so the page then watches two
// things: GET /update/install, which says how the updater ended while this
// daemon still runs (most failures come before the restart), and /health,
// which answers without a session once the restart ended it: the new version
// means it worked and the page reloads; the old version from a new process
// means the install stopped and the old program was started again.

import { api, errorText } from './api.js'
import { h, notice, replaceContent } from './dom.js'

/**
 * @typedef {object} Release
 * @property {string} version
 * @property {string[]} changes breaking lines first
 * @property {string[]} breaking
 * @property {boolean} staged
 * @property {boolean} installable
 */

/**
 * @typedef {object} Health
 * @property {string} version
 * @property {number} pid
 */

/**
 * @typedef {object} InstallRun
 * @property {string} version
 * @property {string} state running, updated or failed
 * @property {string | null} message
 */

/**
 * @typedef {object} InstallDeps
 * @property {(method: string, path: string, body?: unknown) => Promise<unknown>} send
 * @property {() => Promise<Health | null>} health null while the daemon does not answer
 * @property {() => Promise<InstallRun | null>} installState the updater's record; null once the session is gone or nothing answers
 * @property {() => void} reload
 * @property {(ms: number) => Promise<void>} sleep
 */

const POLL_MS = 2_000
/** Past the updater's own deadline for an install, with room for the restart. */
const GIVE_UP_MS = 20 * 60_000

/** @returns {Promise<Health | null>} */
async function fetchHealth() {
  try {
    const response = await fetch('/health', { cache: 'no-store' })
    if (!response.ok) return null
    const body = await response.json()
    return typeof body?.version === 'string' && Number.isSafeInteger(body?.pid) ? { version: body.version, pid: body.pid } : null
  } catch {
    return null
  }
}

/**
 * Read without api(): after the restart the session is gone, and api() would leave for the login page.
 * @returns {Promise<InstallRun | null>}
 */
async function fetchInstallState() {
  try {
    const response = await fetch('/update/install', { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return null
    const run = (await response.json())?.install
    return typeof run?.version === 'string' && typeof run?.state === 'string' ? { version: run.version, state: run.state, message: typeof run.message === 'string' ? run.message : null } : null
  } catch {
    return null
  }
}

/** @type {InstallDeps} */
const DEFAULT_DEPS = {
  send: api,
  health: fetchHealth,
  installState: fetchInstallState,
  reload: () => location.reload(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** @param {Release} release */
function changeList(release) {
  if (release.changes.length === 0) return h('p', { class: 'hint' }, 'No changelog for this release.')
  const breaking = new Set(release.breaking)
  return h('ul', { class: 'changes' }, ...release.changes.map((line) => h('li', {},
    breaking.has(line) ? [h('span', { class: 'badge run-failed' }, 'Breaking'), ' '] : null,
    line.replace(/^BREAKING:\s*/, ''))))
}

/**
 * Waits for the install to end: a failure the updater recorded, or the daemon coming back after the restart.
 * @param {Release} release
 * @param {InstallDeps} deps
 * @param {Health | null} before the daemon as it was when the button was pressed
 * @param {(message: string, tone?: string) => void} say
 * @returns {Promise<boolean>} false when it ended in a failure the user can try again
 */
async function waitForInstall(release, deps, before, say) {
  let down = false
  for (let waited = 0; waited < GIVE_UP_MS; waited += POLL_MS) {
    await deps.sleep(POLL_MS)
    const run = await deps.installState()
    if (run !== null && run.version === release.version && run.state === 'failed') {
      say(`The install did not finish: ${run.message ?? 'see logs/auto-update.log in the data folder'}`, 'error')
      return false
    }
    const now = await deps.health()
    if (now === null) {
      if (!down) say(`Kinfold is restarting to finish the install of ${release.version}…`)
      down = true
      continue
    }
    if (now.version === release.version) {
      say(`Kinfold ${release.version} is installed. Reloading…`, 'ok')
      deps.reload()
      return true
    }
    if (before !== null && now.pid !== before.pid) {
      say(`The install did not finish; Kinfold is still ${now.version}. Run kinfold update to see why, or read logs/auto-update.log in the data folder.`, 'error')
      return true
    }
  }
  say('Kinfold has not come back yet. Run kinfold status to see where the install is.', 'error')
  return true
}

/**
 * @param {Release} release
 * @param {InstallDeps} [deps]
 * @param {InstallRun | null} [lastRun] the last dashboard install, from GET /update
 */
export function releaseBlock(release, deps = DEFAULT_DEPS, lastRun = null) {
  const status = h('div', { 'aria-live': 'polite' })
  const actions = h('div', { class: 'actions' })
  /** @param {string} message @param {string} [tone] */
  const say = (message, tone = 'quiet') => replaceContent(status, notice(message, tone))
  const showButton = (disabled = false) => replaceContent(actions, h('button', { type: 'button', class: 'primary', disabled, onclick: install }, `Install Kinfold ${release.version}`))
  async function install() {
    showButton(true)
    say(`Installing Kinfold ${release.version}…`)
    // Read before the start: the updater may stop the daemon before the POST's answer arrives.
    const before = await deps.health()
    try {
      await deps.send('POST', '/update/install', { version: release.version })
    } catch (error) {
      say(errorText(error), 'error')
      showButton()
      return
    }
    if (!(await waitForInstall(release, deps, before, say))) showButton()
  }
  if (release.installable) showButton()
  if (lastRun !== null && lastRun.version === release.version && lastRun.state === 'failed') say(`The last install of ${release.version} did not finish: ${lastRun.message ?? 'see logs/auto-update.log in the data folder'}`, 'error')
  return h('section', { class: 'release', 'aria-label': `Kinfold ${release.version}` }, changeList(release), actions, status)
}
