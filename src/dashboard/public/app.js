// The dashboard shell: reads the page and its filters from the URL hash,
// renders that page into <main>, and re-renders on every hash change. A page
// builds a detached tree and the shell swaps it in only if no newer
// navigation started meanwhile, so a slow answer never overwrites a fast one.

import { api, errorText } from './api.js'
import { h, notice, replaceContent } from './dom.js'
import { formatHash, parseHash } from './hash.js'
import { renderData } from './page-data.js'
import { renderMemory } from './page-memory.js'
import { renderMetrics } from './page-metrics.js'
import { renderModels } from './page-models.js'
import { showUpdateBanner } from './update-banner.js'

const PAGES = { models: renderModels, memory: renderMemory, data: renderData, metrics: renderMetrics }
let generation = 0

/** @param {import('./hash.js').HashState} state */
function navigate(state) {
  const hash = formatHash(state)
  if (location.hash === hash) render()
showUpdateBanner(document.getElementById('update-banner'))
  else location.hash = hash
}

function markNav(page) {
  for (const link of document.querySelectorAll('nav.pages a')) {
    if (link.getAttribute('data-page') === page) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
}

async function render() {
  const main = document.getElementById('main')
  if (main === null) return
  const state = parseHash(location.hash)
  const mine = ++generation
  markNav(state.page)
  main.setAttribute('aria-busy', 'true')
  let content
  try {
    content = await PAGES[state.page](state, { navigate, now: Date.now() })
  } catch (error) {
    content = h('section', { class: 'page' }, notice(errorText(error), 'error'))
  }
  if (mine !== generation) return
  replaceContent(main, content)
  main.removeAttribute('aria-busy')
}

function signOut() {
  api('POST', '/dashboard/logout').then(() => location.assign('/dashboard/login'), (error) => {
    const main = document.getElementById('main')
    if (main !== null) replaceContent(main, notice(errorText(error), 'error'))
  })
}

window.addEventListener('hashchange', () => { render() })
document.getElementById('sign-out')?.addEventListener('click', signOut)
render()
showUpdateBanner(document.getElementById('update-banner'))
