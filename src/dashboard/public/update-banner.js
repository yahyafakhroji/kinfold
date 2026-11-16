// The update banner above <main>: the daemon's one-line message, shown as
// text, and under it the release on offer with its change lines and, where
// it can be installed from here, the Install button. It has no dismiss
// state; it goes away once the program is updated.

import { fetchUpdate } from './api.js'
import { notice, replaceContent } from './dom.js'
import { releaseBlock } from './update-install.js'

/** @param {unknown} value @returns {import('./update-install.js').Release | null} */
function releaseOf(value) {
  if (value === null || typeof value !== 'object') return null
  const { version, changes, breaking, staged, installable } = /** @type {Record<string, unknown>} */ (value)
  const lines = (/** @type {unknown} */ list) => Array.isArray(list) && list.every((line) => typeof line === 'string')
  if (typeof version !== 'string' || !lines(changes) || !lines(breaking) || typeof staged !== 'boolean' || typeof installable !== 'boolean') return null
  return { version, changes: /** @type {string[]} */ (changes), breaking: /** @type {string[]} */ (breaking), staged, installable }
}

/** @param {unknown} value @returns {import('./update-install.js').InstallRun | null} */
function runOf(value) {
  if (value === null || typeof value !== 'object') return null
  const { version, state, message } = /** @type {Record<string, unknown>} */ (value)
  return typeof version === 'string' && typeof state === 'string' ? { version, state, message: typeof message === 'string' ? message : null } : null
}

/**
 * @param {Element | null} slot
 */
export async function showUpdateBanner(slot) {
  if (slot === null) return
  const update = await fetchUpdate()
  if (update === null) return
  const release = releaseOf(update.release)
  replaceContent(slot, notice(update.message, 'quiet'), release === null ? null : releaseBlock(release, undefined, runOf(update.install)))
}
