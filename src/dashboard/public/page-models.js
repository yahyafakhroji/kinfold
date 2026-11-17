// Model settings: one form per host (plus the "*" default row) over GET/PUT
// /observer/settings, and a "Test this model" button that sends the form's
// unsaved choice to POST /observer/test. The answer is ok or an error class;
// no reply text and no credential ever comes back to the page.

import { api, errorText } from './api.js'
import { h, notice, replaceContent } from './dom.js'
import { hubOnly } from './central-mark.js'
import { loadEmbeddingsBlock } from './embeddings-block.js'

// The daemon's OBSERVER_PROVIDERS, in its order (a test holds them equal).
export const PROVIDERS = ['claude-cli', 'openrouter', 'codex-cli', 'opencode-cli', 'goose-cli', 'anthropic-api', 'openai-api', 'gemini-api', 'qwen-api', 'openai-compatible']
/** CLI providers that can list their models; goose has no command for it. */
const CLI_PROVIDERS = ['codex-cli', 'opencode-cli']
/** The key-store entry each key provider reads when the field is empty; the OpenAI-compatible endpoint reads none then. */
const KEY_PLACEHOLDERS = { openrouter: 'openrouter', 'anthropic-api': 'anthropic', 'openai-api': 'openai', 'gemini-api': 'gemini', 'qwen-api': 'dashscope', 'openai-compatible': 'none (a local server)' }
const ENDPOINT_PLACEHOLDERS = { 'qwen-api': 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'openai-compatible': 'http://127.0.0.1:11434/v1' }
/** @param {string} provider */
const takesKey = (provider) => Object.hasOwn(KEY_PLACEHOLDERS, provider)
/** @param {string} provider */
const takesEndpoint = (provider) => Object.hasOwn(ENDPOINT_PLACEHOLDERS, provider)
const SOURCES = { host: 'saved for this host', 'default-row': 'from the * default row', 'built-in': 'built-in default' }

/**
 * @typedef {{ provider: string, model: string, credentialRef: string | null, enabled: boolean, source?: string, endpoint?: string }} Choice
 */

/**
 * The body PUT /observer/settings and POST /observer/test both take.
 * @param {string} host
 * @param {FormData} data
 */
export function settingsBody(host, data) {
  const credentialRef = String(data.get('credentialRef') ?? '').trim()
  const endpoint = String(data.get('endpoint') ?? '').trim()
  return {
    host,
    provider: String(data.get('provider') ?? ''),
    model: String(data.get('model') ?? '').trim(),
    enabled: data.get('enabled') === 'on',
    credentialRef: credentialRef === '' ? null : credentialRef,
    ...(endpoint === '' ? {} : { endpoint }),
  }
}

/**
 * The error class of a failed safety test for this provider, or null.
 * @param {{ provider: string, status: string, errorClass: string | null }[]} safety
 * @param {string} provider
 */
export function stoppedClass(safety, provider) {
  const failed = safety.find((row) => row.provider === provider && row.status === 'failed')
  return failed === undefined ? null : failed.errorClass ?? 'unknown'
}

/**
 * The error class of the gate's last failed probe for this provider, or null.
 * A probe failure (CLI missing, not runnable) records no row; the daemon keeps
 * it in memory and clears it once a probe succeeds.
 * @param {{ provider: string, errorClass: string }[]} probe
 * @param {string} provider
 */
export function probeClass(probe, provider) {
  const failed = probe.find((entry) => entry.provider === provider)
  return failed === undefined ? null : failed.errorClass ?? 'unknown'
}

/**
 * What the user is told about a stopped provider. Only safety_check_failed
 * means the model followed the planted instruction; any other class is a
 * cause to fix first.
 * @param {string} errorClass
 */
function stoppedCopy(errorClass) {
  return errorClass === 'safety_check_failed'
    ? ' The safety test failed, so this observer is not running. Change the CLI or model, then press Re-check.'
    : ` This observer is not running: its safety test ended with ${errorClass}. Fix the cause (for example, log in to the CLI), then press Re-check.`
}

/**
 * A "Stopped: <class>" line with a Re-check button. The class comes from the
 * daemon and is shown as text only. The outer box is a plain holder, so the
 * success notice that replaces the error never sits inside an alert.
 * @param {string} provider
 * @param {string} errorClass
 */
export function stoppedNotice(provider, errorClass) {
  const holder = h('div', { class: 'stopped' })
  const box = h('div', { class: 'notice notice-error', role: 'alert' })
  const status = h('span', { 'aria-live': 'polite' })
  const button = h('button', { type: 'button', class: 'quiet', 'data-recheck': '1' }, 'Re-check')
  button.addEventListener('click', () => {
    button.setAttribute('disabled', '')
    replaceContent(status, notice('Re-checking…'))
    api('POST', '/observer/recheck', { provider }).then(
      () => replaceContent(holder, notice('Re-check queued; the next batch tests it again (within a minute).', 'ok')),
      (error) => { button.removeAttribute('disabled'); replaceContent(status, notice(errorText(error), 'error')) })
  })
  replaceContent(box, h('span', { class: 'badge run-failed' }, `Stopped: ${errorClass}`), stoppedCopy(errorClass), button, status)
  replaceContent(holder, box)
  return holder
}

/**
 * A "Not running: <class>" line for a provider whose CLI probe failed. The
 * daemon retries on its own, so there is nothing to press.
 * @param {string} errorClass
 */
function notRunningNotice(errorClass) {
  return h('div', { class: 'notice notice-error not-running', role: 'alert' },
    h('span', { class: 'badge run-failed' }, `Not running: ${errorClass}`),
    ' The daemon could not start this CLI. Fix the cause (for example, install it, log in, or re-run the installer so the daemon\'s PATH finds it); the daemon tries again on its own.')
}

/**
 * The daemon's "has failed N times" line for a provider that is backing off,
 * or null. It retries on its own; the line names what to check.
 * @param {{ provider: string, line: string }[]} backoff
 * @param {string} provider
 */
function backoffNotice(backoff, provider) {
  const entry = backoff.find((item) => item.provider === provider)
  if (entry === undefined || typeof entry.line !== 'string') return null
  return h('div', { class: 'notice notice-error backing-off', role: 'alert' },
    h('span', { class: 'badge run-failed' }, 'Backing off'), `: ${entry.line}`)
}

/** One in-flight /observer/models request per provider, shared by every form. @type {Map<string, Promise<any>>} */
const modelRequests = new Map()

/** @param {string} provider */
function fetchModelNames(provider) {
  const shared = modelRequests.get(provider)
  if (shared !== undefined) return shared
  const request = api('GET', `/observer/models?provider=${encodeURIComponent(provider)}`).finally(() => modelRequests.delete(provider))
  modelRequests.set(provider, request)
  return request
}

/**
 * Fills a datalist with the installed CLI's model names. Failures leave it empty:
 * a typed name is always accepted.
 * @param {Element} list
 * @param {string} provider
 */
function loadModelNames(list, provider) {
  if (!CLI_PROVIDERS.includes(provider)) { replaceContent(list); return }
  fetchModelNames(provider).then(
    (answer) => {
      const names = answer.ok === true && Array.isArray(answer.models) ? answer.models.filter((name) => typeof name === 'string') : []
      replaceContent(list, names.map((name) => h('option', { value: name })))
    },
    () => replaceContent(list))
}

/**
 * @param {string} host
 * @param {Choice | null} choice null for a "*" row that does not exist yet
 * @param {string | null} problem the effective setting's error class, if it could not be resolved
 * @param {{ provider: string, status: string, errorClass: string | null }[]} [safety]
 * @param {{ provider: string, errorClass: string }[]} [probe]
 * @param {{ provider: string, line: string }[]} [backoff]
 */
function hostForm(host, choice, problem, safety = [], probe = [], backoff = []) {
  const id = (name) => `${name}-${host === '*' ? 'default' : host}`
  const status = h('div', { class: 'test-status', 'aria-live': 'polite' })
  const current = choice ?? { provider: 'claude-cli', model: 'haiku', credentialRef: null, enabled: true }
  const stopped = stoppedClass(safety, current.provider)
  const unprobed = probeClass(probe, current.provider)
  const models = h('datalist', { id: id('models') })
  const form = h('form', { class: 'host-form' },
    h('header', { class: 'host-head' },
      h('h2', {}, host === '*' ? 'Default (*)' : host),
      h('p', { class: 'hint' }, choice === null ? 'No default row: hosts without their own row use the built-in default.' : SOURCES[choice.source ?? 'host'] ?? '')),
    problem === null ? null : notice(`This host's setting cannot be used: ${problem}`, 'error'),
    unprobed === null ? null : notRunningNotice(unprobed),
    backoffNotice(backoff, current.provider),
    stopped === null ? null : stoppedNotice(current.provider, stopped),
    h('div', { class: 'form-grid' },
      h('label', { class: 'field', for: id('provider') }, h('span', { class: 'field-label' }, 'Provider'),
        h('select', { id: id('provider'), name: 'provider' }, PROVIDERS.map((provider) => h('option', { value: provider, selected: provider === current.provider }, provider)))),
      h('label', { class: 'field field-wide', for: id('model') }, h('span', { class: 'field-label' }, 'Model'),
        h('input', { id: id('model'), name: 'model', value: current.model, required: true, maxlength: 200, class: 'mono', autocomplete: 'off', spellcheck: 'false', list: id('models') }), models),
      h('label', { class: 'field field-wide', for: id('endpoint'), 'data-endpoint': '1', hidden: !takesEndpoint(current.provider) }, h('span', { class: 'field-label' }, 'Endpoint'),
        h('input', { id: id('endpoint'), name: 'endpoint', value: current.endpoint ?? '', placeholder: ENDPOINT_PLACEHOLDERS[current.provider] ?? '', maxlength: 500, class: 'mono', autocomplete: 'off', spellcheck: 'false', inputmode: 'url' })),
      h('label', { class: 'field', for: id('credential'), 'data-credential': '1', hidden: !takesKey(current.provider) }, h('span', { class: 'field-label' }, 'Keychain entry'),
        h('input', { id: id('credential'), name: 'credentialRef', value: current.credentialRef ?? '', placeholder: KEY_PLACEHOLDERS[current.provider] ?? '', maxlength: 64, class: 'mono', autocomplete: 'off', spellcheck: 'false' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'enabled', checked: current.enabled }), ' Observer enabled')),
    h('div', { class: 'actions' },
      h('button', { type: 'submit', class: 'primary' }, 'Save'),
      h('button', { type: 'button', class: 'quiet', 'data-test': '1' }, 'Test this model')),
    status)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    replaceContent(status, notice('Saving…'))
    api('PUT', '/observer/settings', settingsBody(host, new FormData(form))).then(
      () => replaceContent(status, notice('Saved. The observer uses it from its next batch.', 'ok')),
      (error) => replaceContent(status, notice(errorText(error), 'error')))
  })
  const providerSelect = form.querySelector('select[name="provider"]')
  const credentialField = form.querySelector('[data-credential]')
  const endpointField = form.querySelector('[data-endpoint]')
  const credentialInput = form.querySelector('input[name="credentialRef"]')
  const endpointInput = form.querySelector('input[name="endpoint"]')
  providerSelect?.addEventListener('change', () => {
    const provider = providerSelect.value
    if (credentialField) credentialField.hidden = !takesKey(provider)
    if (endpointField) endpointField.hidden = !takesEndpoint(provider)
    if (credentialInput) credentialInput.setAttribute('placeholder', KEY_PLACEHOLDERS[provider] ?? '')
    if (endpointInput) endpointInput.setAttribute('placeholder', ENDPOINT_PLACEHOLDERS[provider] ?? '')
    loadModelNames(models, provider)
  })
  loadModelNames(models, current.provider)
  const testButton = form.querySelector('[data-test]')
  testButton?.addEventListener('click', () => runTest(host, form, status, testButton))
  return form
}

/**
 * @param {string} host
 * @param {HTMLFormElement} form
 * @param {Element} status
 * @param {Element} button
 */
function runTest(host, form, status, button) {
  button.setAttribute('disabled', '')
  replaceContent(status, notice('Sending one short check prompt…'))
  api('POST', '/observer/test', settingsBody(host, new FormData(form)))
    .then((result) => replaceContent(status, result.ok
      ? h('p', { class: 'notice notice-ok', role: 'status' }, h('span', { class: 'badge run-ok' }, 'ok'), ' The model answered.')
      : h('p', { class: 'notice notice-error', role: 'alert' }, h('span', { class: 'badge run-failed' }, result.errorClass), ' The check failed with this error class.')),
    (error) => replaceContent(status, notice(errorText(error), 'error')))
    .finally(() => button.removeAttribute('disabled'))
}

/**
 * @typedef {{ rows: { host: string, provider: string, model: string, credentialRef: string | null, enabled: boolean }[], effective: ({ host: string, settings: Choice } | { host: string, error: string })[], safety?: { provider: string, status: string, errorClass: string | null }[], probe?: { provider: string, errorClass: string }[], backoff?: { provider: string, line: string }[] }} SettingsView
 */

/**
 * @param {SettingsView} view
 */
export function hostEntries(view) {
  const star = view.rows.find((row) => row.host === '*') ?? null
  const hosts = view.effective.map((entry) => 'settings' in entry
    ? { host: entry.host, choice: entry.settings, problem: null }
    : { host: entry.host, choice: view.rows.find((row) => row.host === entry.host) ?? null, problem: entry.error })
  return [...hosts, { host: '*', choice: star === null ? null : { ...star, source: 'host' }, problem: null }]
}

/**
 * One form per host entry.
 * @param {SettingsView} view
 */
export function hostForms(view) {
  const safety = Array.isArray(view.safety) ? view.safety : []
  const probe = Array.isArray(view.probe) ? view.probe : []
  const backoff = Array.isArray(view.backoff) ? view.backoff : []
  return hostEntries(view).map((entry) => hostForm(entry.host, entry.choice, entry.problem, safety, probe, backoff))
}

/**
 * An OpenAI-compatible observer's address on this machine, offered as the
 * local LLM embedding address; a remote one never is.
 * @param {SettingsView} view
 */
export function loopbackObserverEndpoint(view) {
  const row = view.rows.find((entry) => entry.provider === 'openai-compatible' && typeof entry.endpoint === 'string' && /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/.test(entry.endpoint))
  return row === undefined ? null : row.endpoint
}

export async function renderModels() {
  const view = await api('GET', '/observer/settings')
  const embeddings = await loadEmbeddingsBlock(loopbackObserverEndpoint(view))
  return hubOnly(h('section', { class: 'page', 'aria-labelledby': 'page-title' },
    h('header', { class: 'page-head' }, h('p', { class: 'kicker' }, '01'), h('h1', { id: 'page-title' }, 'Model settings'),
      h('p', { class: 'lede' }, 'Which observer model turns each host\'s events into memory. There is no silent fallback: a failing model keeps events queued.')),
    h('div', { class: 'host-forms' }, hostForms(view)),
    embeddings))
}
