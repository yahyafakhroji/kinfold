// The update banner above <main>: the daemon's one-line message, shown as
// text. It has no dismiss state; it goes away once the program is updated.

import { fetchUpdateMessage } from './api.js'
import { notice, replaceContent } from './dom.js'

/**
 * @param {Element | null} slot
 */
export async function showUpdateBanner(slot) {
  if (slot === null) return
  const message = await fetchUpdateMessage()
  if (message !== null) replaceContent(slot, notice(message, 'quiet'))
}
