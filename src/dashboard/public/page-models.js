// Model settings: one form per host (plus the "*" default row) over GET/PUT
// /observer/settings, and a "Test this model" button that sends the form's
// unsaved choice to POST /observer/test. The answer is ok or an error class;
// no reply text and no credential ever comes back to the page.

import { api, errorText } from './api.js'
import { h, notice, replaceContent } from './dom.js'

export const PROVIDERS = ['claude-cli', 'openrouter', 'codex-cli', 'opencode-cli']
const CLI_PROVIDERS = ['codex-cli', 'opencode-cli']
const SOURCES = { host: 'saved for this host', 'default-row': 'from the * default row', 'built-in': 'built-in default' }

/**
 * @typedef {{ provider: string, model: string, credentialRef: string | null, enabled: boolean, source?: string }} Choice
 */

/**
 * The body PUT /observer/settings and POST /observer/test both take.
 * @param {string} host
 * @param {FormData} data
 */
export function settingsBody(host, data) {
  const credentialRef = String(data.get('credentialRef') ?? '').trim()
  return {
    host,
    provider: String(data.get('provider') ?? ''),
    model: String(data.get('model') ?? '').trim(),
    enabled: data.get('enabled') === 'on',
    credentialRef: credentialRef === '' ? null : credentialRef,
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
 * A "Stopped: <class>" line with a Re-check button. The class comes from the
 * daemon and is shown as text only.
 * @param {string} provider
 * @param {string} errorClass
 */
function stoppedNotice(provider, errorClass) {
  const box = h('div', { class: 'notice notice-error stopped', role: 'alert' })
  const status = h('span', { 'aria-live': 'polite' })
  const button = h('button', { type: 'button', class: 'quiet', 'data-recheck': '1' }, 'Re-check')
  button.addEventListener('click', () => {
    button.setAttribute('disabled', '')
    replaceContent(status, notice('Re-checking…'))
    api('POST', '/observer/recheck', { provider }).then(
      () => replaceContent(box, notice('Re-check queued; the next batch tests it again (within a minute).', 'ok')),
      (error) => { button.removeAttribute('disabled'); replaceContent(status, notice(errorText(error), 'error')) })
  })
  replaceContent(box, h('span', { class: 'badge run-failed' }, `Stopped: ${errorClass}`), ' The safety test failed, so this observer is not running. ', button, status)
  return box
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
 */
function hostForm(host, choice, problem, safety = []) {
  const id = (name) => `${name}-${host === '*' ? 'default' : host}`
  const status = h('div', { class: 'test-status', 'aria-live': 'polite' })
  const current = choice ?? { provider: 'claude-cli', model: 'haiku', credentialRef: null, enabled: true }
  const stopped = stoppedClass(safety, current.provider)
  const models = h('datalist', { id: id('models') })
  const form = h('form', { class: 'host-form' },
    h('header', { class: 'host-head' },
      h('h2', {}, host === '*' ? 'Default (*)' : host),
      h('p', { class: 'hint' }, choice === null ? 'No default row: hosts without their own row use the built-in default.' : SOURCES[choice.source ?? 'host'] ?? '')),
    problem === null ? null : notice(`This host's setting cannot be used: ${problem}`, 'error'),
    stopped === null ? null : stoppedNotice(current.provider, stopped),
    h('div', { class: 'form-grid' },
      h('label', { class: 'field', for: id('provider') }, h('span', { class: 'field-label' }, 'Provider'),
        h('select', { id: id('provider'), name: 'provider' }, PROVIDERS.map((provider) => h('option', { value: provider, selected: provider === current.provider }, provider)))),
      h('label', { class: 'field field-wide', for: id('model') }, h('span', { class: 'field-label' }, 'Model'),
        h('input', { id: id('model'), name: 'model', value: current.model, required: true, maxlength: 200, class: 'mono', autocomplete: 'off', spellcheck: 'false', list: id('models') }), models),
      h('label', { class: 'field', for: id('credential'), 'data-credential': '1', hidden: current.provider !== 'openrouter' }, h('span', { class: 'field-label' }, 'Keychain entry'),
        h('input', { id: id('credential'), name: 'credentialRef', value: current.credentialRef ?? '', placeholder: 'openrouter', maxlength: 64, class: 'mono', autocomplete: 'off', spellcheck: 'false' })),
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
  providerSelect?.addEventListener('change', () => {
    if (credentialField) credentialField.hidden = providerSelect.value !== 'openrouter'
    loadModelNames(models, providerSelect.value)
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
 * @param {{ rows: { host: string, provider: string, model: string, credentialRef: string | null, enabled: boolean }[], effective: ({ host: string, settings: Choice } | { host: string, error: string })[], safety?: { provider: string, status: string, errorClass: string | null }[] }} view
 */
export function hostEntries(view) {
  const star = view.rows.find((row) => row.host === '*') ?? null
  const hosts = view.effective.map((entry) => 'settings' in entry
    ? { host: entry.host, choice: entry.settings, problem: null }
    : { host: entry.host, choice: view.rows.find((row) => row.host === entry.host) ?? null, problem: entry.error })
  return [...hosts, { host: '*', choice: star === null ? null : { ...star, source: 'host' }, problem: null }]
}

export async function renderModels() {
  const view = await api('GET', '/observer/settings')
  return h('section', { class: 'page', 'aria-labelledby': 'page-title' },
    h('header', { class: 'page-head' }, h('p', { class: 'kicker' }, '01'), h('h1', { id: 'page-title' }, 'Model settings'),
      h('p', { class: 'lede' }, 'Which observer model turns each host\'s events into memory. There is no silent fallback: a failing model keeps events queued.')),
    h('div', { class: 'host-forms' }, hostEntries(view).map((entry) => hostForm(entry.host, entry.choice, entry.problem, view.safety ?? []))))
}
