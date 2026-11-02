// Data control over the /data routes: size by table and project with
// the warning threshold, per-table retention (editable), the leak findings
// list (rule, table, row, age; never a value) with redact or purge, and a
// purge by session, project, host or date range whose confirm button only
// appears after a dry run for exactly the target in the form.

import { api, errorText } from './api.js'
import { h, notice, replaceContent, table } from './dom.js'
import { formatAge, formatBytes } from './format.js'
import { canConfirm, confirmBody, describeCounts, dryRunBody, idleFlow, previewed } from './purge-flow.js'
import { canSave, describePreview, idleRetention, previewBody, previewedRetention, saveBody } from './retention-flow.js'

export const RETENTION_TABLES = ['events', 'prompts', 'observations', 'summaries']
const RETENTION_NOTES = { events: 'payload text', prompts: 'prompt text', observations: 'whole rows', summaries: 'whole rows, by last use' }
export const PURGE_KINDS = ['session', 'project', 'host', 'range']
const MB = 1024 * 1024

/** @param {string} kicker @param {string} title @param {...import('./dom.js').Child} body */
function section(kicker, title, ...body) {
  return h('section', { class: 'block', 'aria-label': title }, h('h2', { class: 'block-title' }, h('span', { class: 'kicker' }, kicker), ' ', title), ...body)
}

/** @param {import('../../data-control/size').SizeReport} size */
function sizeBlock(size) {
  return section('A', 'Size',
    h('p', { class: 'figure' }, h('span', { class: 'figure-value' }, formatBytes(size.totalBytes)),
      h('span', { class: size.overWarn ? 'badge run-failed' : 'badge run-ok' }, size.overWarn ? 'over threshold' : 'under threshold'),
      h('span', { class: 'hint' }, ` warns at ${formatBytes(size.warnBytes)} · free pages ${formatBytes(size.freeBytes)} · source ${size.source}`)),
    h('div', { class: 'two-up' },
      table('Size by table', ['Table', 'Size'], size.tables.map((row) => [h('span', { class: 'mono' }, row.name), formatBytes(row.bytes)])),
      table('Size by project', ['Project', 'Events', 'Observations', 'Prompts'], size.projects.map((row) => [
        h('span', {}, row.displayName, h('br', {}), h('span', { class: 'mono hint' }, row.projectKey)),
        `${row.events} · ${formatBytes(row.eventBytes)}`, `${row.observations} · ${formatBytes(row.observationBytes)}`, formatBytes(row.promptBytes)]))))
}

/**
 * The PUT /data/retention body from the form: blank days keep forever.
 * @param {FormData} data
 */
export function retentionBody(data) {
  const retention = Object.fromEntries(RETENTION_TABLES.map((name) => {
    const text = String(data.get(name) ?? '').trim()
    return [name, text === '' ? null : Number(text)]
  }))
  const warnMb = Number(String(data.get('warnMb') ?? '').trim())
  return { retention, warnBytes: Math.round(warnMb * MB) }
}

/**
 * @typedef {object} RetentionDeps
 * @property {(method: string, path: string, body: unknown) => Promise<any>} send
 * @property {(form: HTMLFormElement) => import('./retention-flow.js').RetentionBody} read the body the form holds now
 */

/** @type {RetentionDeps} */
const LIVE_RETENTION = { send: api, read: (form) => retentionBody(new FormData(form)) }

/**
 * Preview first: Save stays disabled until a preview was shown for exactly
 * the values in the form, and any edit disables it again.
 * @param {import('../../store/data-settings-store').DataSettings} settings
 * @param {RetentionDeps} [deps]
 */
export function retentionBlock(settings, deps = LIVE_RETENTION) {
  let flow = idleRetention()
  const status = h('div', { 'aria-live': 'polite' })
  const save = h('button', { type: 'button', class: 'primary', disabled: true }, 'Save retention')
  const form = h('form', { class: 'form-grid' },
    RETENTION_TABLES.map((name) => h('label', { class: 'field' },
      h('span', { class: 'field-label' }, `${name} (${RETENTION_NOTES[name]})`),
      h('input', { type: 'number', name, min: 1, max: 36500, step: 1, value: settings.retention[name] ?? '', placeholder: 'keep', inputmode: 'numeric' }))),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Size warning (MB)'),
      h('input', { type: 'number', name: 'warnMb', min: 1, step: 1, value: Math.round(settings.warnBytes / MB), required: true, inputmode: 'numeric' })),
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'quiet' }, 'Preview'), save))
  const drawSave = () => (canSave(flow, deps.read(form)) ? save.removeAttribute('disabled') : save.setAttribute('disabled', ''))
  const fail = (error) => replaceContent(status, notice(errorText(error), 'error'))
  form.addEventListener('input', () => {
    if (flow.stage === 'previewed' && !canSave(flow, deps.read(form))) replaceContent(status, notice('The values changed; preview again before saving.'))
    drawSave()
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const body = deps.read(form)
    deps.send('PUT', '/data/retention', previewBody(body)).then((answer) => {
      flow = previewedRetention(body, answer)
      replaceContent(status, h('p', { class: 'preview' }, `Preview, nothing saved. Saving now would expire: ${describePreview(answer.preview, RETENTION_TABLES)}.`))
      drawSave()
    }, fail)
  })
  save.addEventListener('click', () => {
    if (!canSave(flow, deps.read(form))) return drawSave()
    deps.send('PUT', '/data/retention', saveBody(flow, deps.read(form))).then((answer) => {
      flow = idleRetention()
      drawSave()
      replaceContent(status, notice(`Saved. Applied now: events ${answer.applied.events}, prompts ${answer.applied.prompts}, observations ${answer.applied.observations}, summaries ${answer.applied.summaries}.`, 'ok'))
    }, fail)
  })
  return section('B', 'Retention', h('p', { class: 'hint' }, 'Days to keep; leave blank to keep forever. Preview shows what a save would expire at once; Save applies it.'), form, status)
}

/**
 * One findings row. A purge needs a second click on the same row.
 * @param {import('../../store/findings-store').Finding} finding
 * @param {number} now
 * @param {() => void} reload
 */
export function findingCells(finding, now, reload) {
  const actions = h('div', { class: 'actions tight' })
  const resolve = (action) => api('POST', `/data/findings/${finding.id}/resolve`, { action }).then(reload, (error) => replaceContent(actions, notice(errorText(error), 'error')))
  const draw = (armed) => replaceContent(actions,
    finding.action !== 'pending' ? h('span', { class: 'hint' }, finding.action) : [
      h('button', { type: 'button', class: 'quiet', onclick: () => resolve('redact') }, 'Redact'),
      armed ? h('button', { type: 'button', class: 'danger', onclick: () => resolve('purge') }, 'Confirm purge row')
        : h('button', { type: 'button', class: 'danger-quiet', onclick: () => draw(true) }, 'Purge row'),
    ])
  draw(false)
  return [h('span', { class: 'mono' }, finding.rule), finding.table, h('span', { class: 'mono' }, finding.rowId), h('span', { class: 'mono' }, finding.field ?? '—'), formatAge(finding.foundAt, now), String(finding.matches), actions]
}

/** @param {number} now */
function findingsBlock(now) {
  const body = h('div', {}, notice('Loading findings…'))
  const load = () => api('GET', '/data/findings?action=pending').then(
    (view) => replaceContent(body,
      h('p', { class: 'hint' }, `Pending by rule: ${Object.entries(view.pendingByRule).map(([rule, n]) => `${rule} ${n}`).join(', ') || 'none'}`),
      table('Leak findings', ['Rule', 'Table', 'Row', 'Field', 'Age', 'Matches', ''], view.findings.map((finding) => findingCells(finding, now, load)), 'No pending findings. Stored text passes the current redaction rules.')),
    (error) => replaceContent(body, notice(errorText(error), 'error')))
  const scan = h('button', { type: 'button', class: 'quiet', onclick: () => api('POST', '/data/scan', {}).then(load, (error) => replaceContent(body, notice(errorText(error), 'error'))) }, 'Scan now')
  load()
  return section('C', 'Leak findings', h('p', { class: 'hint' }, 'Rows that the current rules would redact. Values are never shown.'), h('div', { class: 'actions' }, scan), body)
}

/**
 * The purge target the form names now, or an error message.
 * @param {FormData} data
 * @returns {{ ok: true, target: Record<string, string | number> } | { ok: false, error: string }}
 */
export function purgeTarget(data) {
  const kind = String(data.get('kind') ?? '')
  const value = String(data.get('value') ?? '').trim()
  if (kind === 'session') {
    const id = Number(value)
    return Number.isSafeInteger(id) && id > 0 ? { ok: true, target: { session: id } } : { ok: false, error: 'enter a session id' }
  }
  if (kind === 'project' || kind === 'host') return value === '' ? { ok: false, error: `enter a ${kind}` } : { ok: true, target: { [kind]: value } }
  if (kind !== 'range') return { ok: false, error: 'pick what to purge' }
  const before = Date.parse(String(data.get('before') ?? ''))
  const afterText = String(data.get('after') ?? '')
  const after = afterText === '' ? null : Date.parse(afterText)
  if (!Number.isFinite(before)) return { ok: false, error: 'enter the end of the range' }
  if (after !== null && !Number.isFinite(after)) return { ok: false, error: 'the start of the range is not a date' }
  return { ok: true, target: after === null ? { before: new Date(before).toISOString() } : { after: new Date(after).toISOString(), before: new Date(before).toISOString() } }
}

/** @param {{ projectKey: string, displayName: string }[]} projects */
function purgeBlock(projects) {
  let flow = idleFlow()
  const status = h('div', { 'aria-live': 'polite' })
  const confirmSlot = h('div', { class: 'actions' })
  const form = h('form', { class: 'form-grid' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Purge by'),
      h('select', { name: 'kind' }, PURGE_KINDS.map((kind) => h('option', { value: kind }, kind === 'range' ? 'date range' : kind)))),
    h('label', { class: 'field field-wide' }, h('span', { class: 'field-label' }, 'Session id, project key or host'),
      h('input', { name: 'value', list: 'purge-projects', class: 'mono', autocomplete: 'off', spellcheck: 'false' })),
    h('datalist', { id: 'purge-projects' }, projects.map((project) => h('option', { value: project.projectKey }, project.displayName))),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'From (range, optional)'), h('input', { type: 'datetime-local', name: 'after' })),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Before (range)'), h('input', { type: 'datetime-local', name: 'before' })),
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'danger-quiet' }, 'Dry run')))
  const current = () => purgeTarget(new FormData(form))
  const drawConfirm = () => {
    const target = current()
    replaceContent(confirmSlot, target.ok && canConfirm(flow, target.target)
      ? h('button', { type: 'button', class: 'danger', onclick: () => confirm(target.target) }, 'Confirm purge')
      : null)
  }
  const confirm = (target) => api('POST', '/data/purge', confirmBody(flow, target)).then(
    (report) => { flow = idleFlow(); drawConfirm(); replaceContent(status, notice(`Purged: ${describeCounts(report.counts)}.`, 'ok')) },
    (error) => replaceContent(status, notice(errorText(error), 'error')))
  form.addEventListener('input', () => { if (flow.stage === 'previewed') replaceContent(status, notice('The target changed; run the dry run again.')); drawConfirm() })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const target = current()
    if (!target.ok) return replaceContent(status, notice(target.error, 'error'))
    api('POST', '/data/purge', dryRunBody(target.target)).then(
      (report) => { flow = previewed(target.target, report); replaceContent(status, h('p', { class: 'preview' }, `Dry run, nothing changed. Would remove: ${describeCounts(report.counts)}.`)); drawConfirm() },
      (error) => replaceContent(status, notice(errorText(error), 'error')))
  })
  return section('D', 'Purge', h('p', { class: 'hint' }, 'Deletes rows, their search entries and context packs, then scrubs freed pages. A dry run always comes first.'), form, status, confirmSlot)
}

/** @param {unknown} _state @param {{ now: number }} ctx */
export async function renderData(_state, ctx) {
  const [size, settings] = await Promise.all([api('GET', '/data/size'), api('GET', '/data/retention')])
  return h('section', { class: 'page', 'aria-labelledby': 'page-title' },
    h('header', { class: 'page-head' }, h('p', { class: 'kicker' }, '03'), h('h1', { id: 'page-title' }, 'Data control'),
      h('p', { class: 'lede' }, 'What stays, for how long, and what goes.')),
    sizeBlock(size), retentionBlock(settings), findingsBlock(ctx.now), purgeBlock(size.projects))
}
