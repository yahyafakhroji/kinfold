// The URL hash holds the page, its filters and the page number, so a reload
// or a shared link (on this machine) lands in the same place. The hash never
// carries a credential: the login code lives in /dashboard/login's fragment
// only until login.js replaces the URL.

export const PAGES = ['models', 'memory', 'data', 'metrics', 'backup']
export const DEFAULT_PAGE = 'memory'

/** @typedef {{ page: string, params: Record<string, string> }} HashState */

/**
 * "#memory?host=opencode&page=2" -> { page: 'memory', params: { host: 'opencode', page: '2' } }
 * @param {string} hash
 * @returns {HashState}
 */
export function parseHash(hash) {
  const body = hash.startsWith('#') ? hash.slice(1) : hash
  const at = body.indexOf('?')
  const name = at === -1 ? body : body.slice(0, at)
  const page = PAGES.includes(name) ? name : DEFAULT_PAGE
  const params = Object.fromEntries(new URLSearchParams(at === -1 ? '' : body.slice(at + 1)))
  return { page, params }
}

/**
 * Empty values are dropped and keys sorted, so equal states give equal hashes.
 * @param {HashState} state
 */
export function formatHash(state) {
  const entries = Object.entries(state.params).filter(([, value]) => value !== '').sort(([a], [b]) => a.localeCompare(b))
  const query = new URLSearchParams(entries).toString()
  return `#${state.page}${query === '' ? '' : `?${query}`}`
}

/**
 * A new state with `changes` applied. Changing a filter goes back to page 1
 * and closes an open detail, unless the change names them itself. A one-off
 * `done` message never carries over to the next state.
 * @param {HashState} state
 * @param {Record<string, string>} changes
 * @returns {HashState}
 */
export function withParams(state, changes) {
  const resets = 'page' in changes || 'id' in changes ? { done: '' } : { page: '', id: '', done: '' }
  return { page: state.page, params: { ...state.params, ...resets, ...changes } }
}
