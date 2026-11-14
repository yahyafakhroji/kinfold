// Backup and restore over the daemon's /backup and /restore routes.
// Backup is a plain download link: the browser saves the file the daemon
// streams. Restore uploads a chosen file, shows what its manifest says, takes
// the recovery code and a confirmation, then follows GET /restore/status
// until the daemon reports how it ended. The session survives the restore,
// so this page stays signed in throughout.
//
// The recovery code is read from its field once, put in the body of the one
// POST /restore, and the field is cleared in the same step. It is never kept
// in a variable that outlives the click, never rendered, and never in a URL.

import { api, errorText, uploadFile } from './api.js'
import { h, notice, replaceContent } from './dom.js'
import { canRestore, describeManifest, idleRestore, restoreBody, stepText, uploadedRestore } from './restore-flow.js'

const STATUS_POLL_MS = 700

/**
 * @typedef {object} BackupDeps
 * @property {(method: string, path: string, body?: unknown) => Promise<any>} send
 * @property {(path: string, file: unknown) => Promise<any>} upload
 * @property {(ms: number) => Promise<void>} wait
 */

/** @type {BackupDeps} */
const LIVE = { send: api, upload: uploadFile, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }

/** @param {string} kicker @param {string} title @param {...import('./dom.js').Child} body */
function section(kicker, title, ...body) {
  return h('section', { class: 'block', 'aria-label': title }, h('h2', { class: 'block-title' }, h('span', { class: 'kicker' }, kicker), ' ', title), ...body)
}

function backupBlock() {
  return section('A', 'Back up',
    h('p', { class: 'lede' }, 'One file holding everything Kinfold remembers. Capture keeps running while it is written.'),
    h('p', { class: 'hint' }, 'The file stays encrypted with this store’s key and holds no key of its own. Restoring it needs the recovery code, so keep that code somewhere other than this machine: kinfold key show-recovery prints it.'),
    h('div', { class: 'actions' }, h('a', { class: 'button primary', href: '/backup', download: true }, 'Download backup')))
}

/** @param {HTMLElement} button @param {boolean} enabled */
function setEnabled(button, enabled) {
  if (enabled) button.removeAttribute('disabled')
  else button.setAttribute('disabled', '')
}

/** @param {BackupDeps} deps */
function restoreBlock(deps) {
  let flow = idleRestore()
  let running = false
  const status = h('div', { 'aria-live': 'polite' })
  const facts = h('div', {})
  const file = h('input', { type: 'file', name: 'file', accept: '.kfb' })
  const upload = h('button', { type: 'button', class: 'quiet', 'data-action': 'upload', disabled: true }, 'Read backup')
  const code = h('input', { type: 'password', name: 'code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'XXXXX-XXXXX-…' })
  const codeField = h('label', { class: 'field field-wide', 'data-action': 'code-field', hidden: true }, h('span', { class: 'field-label' }, 'Recovery code of the backup'), code)
  const confirm = h('input', { type: 'checkbox', name: 'confirm' })
  const restore = h('button', { type: 'button', class: 'danger', 'data-action': 'restore', disabled: true }, 'Restore')

  const chosen = () => (file.files !== undefined && file.files !== null ? file.files[0] : undefined)
  const draw = () => {
    setEnabled(upload, !running && chosen() !== undefined)
    setEnabled(restore, !running && canRestore(flow, String(code.value ?? ''), confirm.checked === true))
  }
  const fail = (error) => replaceContent(status, notice(errorText(error), 'error'))

  /** Follows the restore until the daemon says how it ended. */
  const follow = async () => {
    for (;;) {
      const answer = await deps.send('GET', '/restore/status')
      if (answer.state === 'done') {
        flow = idleRestore()
        replaceContent(facts)
        replaceContent(status, notice('The backup is restored.', 'ok'), h('ul', { class: 'plain' }, (answer.lines ?? []).map((line) => h('li', {}, String(line)))))
        return
      }
      if (answer.state !== 'running') {
        fail(new Error(typeof answer.error === 'string' ? answer.error : 'the restore failed'))
        return
      }
      replaceContent(status, notice(stepText(answer.step ?? null)))
      await deps.wait(STATUS_POLL_MS)
    }
  }

  file.addEventListener('change', () => {
    flow = idleRestore()
    replaceContent(facts)
    codeField.setAttribute('hidden', '')
    draw()
  })
  upload.addEventListener('click', () => {
    const picked = chosen()
    if (picked === undefined || running) return
    running = true
    draw()
    replaceContent(status, notice('Reading the backup…'))
    deps.upload('/restore/upload', picked).then((answer) => {
      flow = uploadedRestore(answer)
      replaceContent(status)
      replaceContent(facts, h('dl', { class: 'facts-grid' }, describeManifest(flow.manifest).map(([label, value]) => [h('dt', {}, label), h('dd', {}, value)])))
      if (flow.manifest.encrypted) codeField.removeAttribute('hidden')
      else codeField.setAttribute('hidden', '')
    }, fail).finally(() => {
      running = false
      draw()
    })
  })
  code.addEventListener('input', draw)
  confirm.addEventListener('change', draw)
  restore.addEventListener('click', () => {
    if (running || !canRestore(flow, String(code.value ?? ''), confirm.checked === true)) return
    const body = restoreBody(flow, String(code.value ?? ''), true)
    // The field gives the code up here: from now on it exists only in this request.
    code.value = ''
    running = true
    draw()
    replaceContent(status, notice(stepText('check')))
    deps.send('POST', '/restore', body).then(follow).catch(fail).finally(() => {
      running = false
      confirm.checked = false
      draw()
    })
  })

  return section('B', 'Restore',
    h('p', { class: 'lede' }, 'Replace the memory on this machine with a backup file.'),
    h('p', { class: 'hint' }, 'If this machine already holds memory, that store is kept beside the restored one and the result says where. An empty store is removed. The OpenRouter key is not part of a backup.'),
    h('div', { class: 'form-grid' },
      h('label', { class: 'field field-wide' }, h('span', { class: 'field-label' }, 'Backup file (.kfb)'), file),
      h('div', { class: 'actions' }, upload)),
    facts,
    h('div', { class: 'form-grid' },
      codeField,
      h('label', { class: 'check field-wide' }, confirm, 'Replace the memory on this machine with this backup'),
      h('div', { class: 'actions' }, restore)),
    status)
}

/**
 * @param {import('./hash.js').HashState} _state
 * @param {unknown} _ctx
 * @param {BackupDeps} [deps]
 */
export async function renderBackup(_state, _ctx, deps = LIVE) {
  return h('section', { class: 'page', 'aria-labelledby': 'page-title' },
    h('header', { class: 'page-head' }, h('p', { class: 'kicker' }, '05'), h('h1', { id: 'page-title' }, 'Backup'),
      h('p', { class: 'lede' }, 'Save the memory before reinstalling or moving machines, and bring it back afterwards.')),
    backupBlock(),
    restoreBlock(deps))
}
