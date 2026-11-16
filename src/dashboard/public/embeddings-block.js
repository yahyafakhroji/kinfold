// The Embeddings block on the models page: which embedder makes the vectors
// for semantic search (GET /embedding/settings), how far its space has come,
// and a switch to another one (PUT /embedding/settings). A switch re-indexes
// in the background; search keeps the old space until the new one is built.
// A local LLM must answer on this machine; the daemon checks it before it
// saves. Only settings, model names and counts reach the page.

import { api, errorText } from './api.js'
import { h, notice, replaceContent } from './dom.js'

const DEFAULT_LLM_URL = 'http://127.0.0.1:11434/v1'
const DEFAULT_LLM_MODEL = 'nomic-embed-text'

/**
 * @typedef {{ model: string, dims: number, indexed: number, pending: number, vecReady: boolean }} Space
 * @typedef {{ provider: string, llmUrl: string | null, llmModel: string | null, llmDims: number | null }} Settings
 * @typedef {{ settings: Settings | null, active: Space | null, building: Space | null, lastError: string | null }} EmbeddingView
 */

/** @param {Settings | null} settings */
function describe(settings) {
  if (settings === null) return 'Not chosen yet; the daemon picks the local model on its next start.'
  if (settings.provider === 'local') return 'Local model, on this machine. Free, and no memory text leaves it.'
  if (settings.provider === 'openrouter') return 'OpenRouter, with the OpenRouter key. Memory text is sent to OpenRouter.'
  return `Local LLM ${settings.llmModel ?? ''} at ${settings.llmUrl ?? ''}.`
}

/** @param {Space} space */
const total = (space) => space.indexed + space.pending

/** @param {EmbeddingView} view */
function progressLines(view) {
  const { active, building } = view
  return [
    active !== null && h('p', { class: 'figure' }, `${active.indexed} of ${total(active)} memories have vectors in ${active.model}.`),
    building !== null && h('p', { class: 'hint' }, `Building ${building.model}: ${building.indexed} of ${total(building)}. ${active === null ? '' : `Search uses ${active.model} until then.`}`),
    view.lastError !== null && notice(`Last indexing error: ${view.lastError}`, 'error'),
  ]
}

/** @param {unknown} value @returns {EmbeddingView | null} */
export function embeddingViewOf(value) {
  if (value === null || typeof value !== 'object' || !('settings' in value)) return null
  return /** @type {EmbeddingView} */ (value)
}

/**
 * @param {EmbeddingView | null} view what GET /embedding/settings reported; null when the daemon has no such route
 * @param {{ send: (method: string, path: string, body: unknown) => Promise<unknown> }} [deps]
 * @param {{ observerEndpoint?: string | null }} [hints] an OpenAI-compatible observer on this machine, offered as the local LLM address
 */
export function embeddingsBlock(view, deps = { send: api }, hints = {}) {
  const status = h('div', { 'aria-live': 'polite' })
  /** @param {Record<string, unknown>} body */
  const save = (body) => {
    replaceContent(status, h('p', { class: 'hint' }, 'Saving...'))
    deps.send('PUT', '/embedding/settings', body).then(
      () => replaceContent(status, notice('Saved. Kinfold re-indexes in the background and switches search over once every memory has a vector.', 'ok')),
      (error) => replaceContent(status, notice(errorText(error), 'error')))
  }
  const title = h('h2', { class: 'block-title' }, h('span', { class: 'kicker' }, 'E'), ' ', 'Embeddings')
  if (view === null) {
    return h('section', { class: 'block', 'aria-label': 'Embeddings' }, title, h('p', { class: 'hint' }, 'This daemon does not report its embedding settings.'))
  }
  const current = view.settings?.provider ?? null
  const url = h('input', { name: 'llmUrl', type: 'url', value: view.settings?.llmUrl ?? hints.observerEndpoint ?? DEFAULT_LLM_URL, 'aria-label': 'Local LLM address' })
  const model = h('input', { name: 'llmModel', type: 'text', value: view.settings?.llmModel ?? DEFAULT_LLM_MODEL, 'aria-label': 'Embedding model' })
  const choice = (provider, label) => current !== provider && h('button', { type: 'button', class: 'quiet', onclick: () => save({ provider }) }, label)
  const llm = h('div', { class: 'actions' }, url, model,
    h('button', { type: 'button', class: 'quiet', onclick: () => save({ provider: 'local-llm', llmUrl: String(url.value ?? '').trim(), llmModel: String(model.value ?? '').trim() }) }, 'Use local LLM'))
  return h('section', { class: 'block', 'aria-label': 'Embeddings' }, title,
    h('p', { class: 'hint' }, 'What turns memories into vectors for semantic search. Each choice is its own index; switching builds the new one in the background.'),
    h('p', {}, describe(view.settings)),
    ...progressLines(view),
    h('div', { class: 'actions' }, choice('local', 'Use local model'), choice('openrouter', 'Use OpenRouter')),
    llm,
    status)
}

/**
 * The block for the page, from the daemon; a failed read renders without the switch.
 * @param {string | null} [observerEndpoint]
 */
export async function loadEmbeddingsBlock(observerEndpoint = null) {
  try {
    return embeddingsBlock(embeddingViewOf(await api('GET', '/embedding/settings')), { send: api }, { observerEndpoint })
  } catch {
    return embeddingsBlock(null)
  }
}
