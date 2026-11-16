// Central memory on the dashboard. On a device that uses a hub's memory, the
// masthead names the hub, and every block that would change or remove stored
// memory is disabled as a whole with "run this on the hub": the daemon would
// refuse those requests anyway. A disabled fieldset disables the controls a
// block adds later too, so a block that loads its own rows stays covered.

import { api } from './api.js'
import { h } from './dom.js'

/** @typedef {{ role: 'local' } | { role: 'hub' } | { role: 'device', hub: string, reachable: boolean | null, problem: string | null }} CentralState */

/** @returns {Promise<CentralState>} */
export async function loadCentral() {
  try {
    const state = await api('GET', '/central/status')
    return state !== null && typeof state === 'object' && 'role' in state ? /** @type {CentralState} */ (state) : { role: 'local' }
  } catch {
    // An older daemon has no such route: it is local.
    return { role: 'local' }
  }
}

/** @param {unknown} state @returns {state is { role: 'device', hub: string, reachable: boolean | null, problem: string | null }} */
function isDevice(state) {
  return state !== null && typeof state === 'object' && /** @type {{ role?: unknown }} */ (state).role === 'device' && typeof /** @type {{ hub?: unknown }} */ (state).hub === 'string'
}

/** @param {Element | null} slot @param {unknown} state */
export function markBrand(slot, state) {
  if (slot === null || !isDevice(state)) return
  while (slot.firstChild !== null) slot.removeChild(slot.firstChild)
  const down = state.reachable === false || state.problem !== null
  slot.appendChild(document.createTextNode(`127.0.0.1 · central: ${state.hub}${down ? ' · not reachable' : ''}`))
}

/**
 * Marks a block as one that changes stored memory.
 * @template {Element} T
 * @param {T} element
 * @returns {T}
 */
export function hubOnly(element) {
  element.setAttribute('data-hub-only', '')
  return element
}

/** @param {Node} node @param {Element[]} found */
function collect(node, found) {
  if (node.nodeType === 1 && /** @type {Element} */ (node).getAttribute('data-hub-only') !== null) {
    found.push(/** @type {Element} */ (node))
    return
  }
  for (const child of [...node.childNodes]) collect(child, found)
}

/** @param {Element} block @param {string} hub */
function disable(block, hub) {
  const keep = block.firstChild !== null && /** @type {Element} */ (block.firstChild).className === 'block-title' ? block.firstChild : null
  const set = h('fieldset', { class: 'hub-only', disabled: true }, h('p', { class: 'notice' }, `Run this on the hub (${hub}): this device uses central memory.`))
  for (const child of [...block.childNodes]) {
    if (child === keep) continue
    block.removeChild(child)
    set.appendChild(child)
  }
  block.appendChild(set)
}

/** @param {Element} root @param {unknown} state */
export function applyHubOnly(root, state) {
  if (!isDevice(state)) return
  /** @type {Element[]} */
  const found = []
  collect(root, found)
  for (const block of found) disable(block, state.hub)
}
