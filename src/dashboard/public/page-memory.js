// Memory browser: observations newest first, filtered by project, host,
// type and evidence, with full-text search and pages of 50; the hash holds
// all of it. A detail view shows one observation with its provenance and
// contradictions, its confirms/updates/contradicts links in both directions,
// how many current observations confirm it,
// and purges it through POST /data/purge after a dry run.
// Every stored value is rendered as text through dom.js.

import { api, errorText } from './api.js'
import { h, notice, replaceContent } from './dom.js'
import { formatAge, formatTime } from './format.js'
import { formatHash, withParams } from './hash.js'
import { canConfirm, confirmBody, describeCounts, dryRunBody, idleFlow, previewed } from './purge-flow.js'

export const EVIDENCE_FILTERS = ['tool-verified', 'interpretation', 'user-stated', 'contradicted']
const FILTER_KEYS = ['project', 'host', 'type', 'evidence', 'q', 'page']

/**
 * @param {string} evidence
 * @param {number | null | undefined} contradictedBy
 */
export function evidenceBadge(evidence, contradictedBy) {
  const shown = contradictedBy !== null && contradictedBy !== undefined ? 'contradicted' : evidence
  return h('span', { class: `badge ev-${shown}` }, shown)
}

/**
 * One list entry. Title, host, type and project are untrusted and become text nodes.
 * "confirmed by N" shows only when current observations confirm the row.
 * @param {{ id: number, projectKey: string, host: string, type: string, evidence: string, title: string, contradictedBy: number | null, occurredAt: number, confirmedBy?: number }} row
 * @param {number} now
 * @param {string} href
 */
export function observationItem(row, now, href) {
  return h('li', { class: 'obs' },
    h('div', { class: 'obs-meta' },
      evidenceBadge(row.evidence, row.contradictedBy),
      h('span', { class: 'host' }, row.host),
      h('span', {}, row.type),
      (row.confirmedBy ?? 0) > 0 ? h('span', { class: 'confirmed' }, `confirmed by ${row.confirmedBy}`) : null,
      h('span', { class: 'mono' }, formatAge(row.occurredAt, now)),
      h('span', { class: 'mono id' }, `#${row.id}`)),
    h('a', { class: 'obs-title', href }, row.title),
    h('div', { class: 'obs-project mono' }, row.projectKey))
}

/** @param {Record<string, string>} params */
export function browsePath(params) {
  const query = new URLSearchParams(FILTER_KEYS.filter((key) => (params[key] ?? '') !== '').map((key) => [key, params[key] ?? '']))
  const text = query.toString()
  return `/memory/observations${text === '' ? '' : `?${text}`}`
}

/**
 * @param {string} name
 * @param {string} label
 * @param {{ value: string, label: string, observations: number }[]} options
 * @param {string} current
 */
function select(name, label, options, current) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label),
    h('select', { name },
      h('option', { value: '' }, 'All'),
      options.map((option) => h('option', { value: option.value, selected: option.value === current }, `${option.label} (${option.observations})`))))
}

/**
 * @param {import('./hash.js').HashState} state
 * @param {import('../../store/memory-reads').Facets} facets
 * @param {(state: import('./hash.js').HashState) => void} navigate
 */
function filterForm(state, facets, navigate) {
  const p = state.params
  const evidence = EVIDENCE_FILTERS.map((value) => ({ value, label: value, observations: 0 }))
  const form = h('form', { class: 'filters', role: 'search' },
    h('label', { class: 'field field-wide' }, h('span', { class: 'field-label' }, 'Search'),
      h('input', { type: 'search', name: 'q', value: p.q ?? '', placeholder: 'words in title, narrative or facts', maxlength: 500 })),
    select('project', 'Project', facets.projects, p.project ?? ''),
    select('host', 'Host', facets.hosts, p.host ?? ''),
    select('type', 'Type', facets.types, p.type ?? ''),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Evidence'),
      h('select', { name: 'evidence' }, h('option', { value: '' }, 'All'),
        evidence.map((option) => h('option', { value: option.value, selected: option.value === (p.evidence ?? '') }, option.label)))),
    h('div', { class: 'actions' },
      h('button', { type: 'submit', class: 'primary' }, 'Apply'),
      h('a', { class: 'button quiet', href: formatHash({ page: 'memory', params: {} }) }, 'Clear')))
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const data = new FormData(form)
    const changes = Object.fromEntries(['q', 'project', 'host', 'type', 'evidence'].map((key) => [key, String(data.get(key) ?? '')]))
    navigate(withParams(state, changes))
  })
  return form
}

/**
 * @param {import('./hash.js').HashState} state
 * @param {{ total: number, page: number, pageSize: number, hasMore: boolean }} result
 */
function pager(state, result) {
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize))
  const link = (page, label) => h('a', { class: 'button quiet', href: formatHash(withParams(state, { page: String(page), id: '' })) }, label)
  return h('nav', { class: 'pager', 'aria-label': 'Pages' },
    result.page > 1 ? link(result.page - 1, '← Newer') : null,
    h('span', { class: 'pager-status' }, `Page ${result.page} of ${pages} · ${result.total} observations`),
    result.hasMore ? link(result.page + 1, 'Older →') : null)
}

/**
 * @param {string} term
 * @param {import('./dom.js').Child} value
 */
function fact(term, value) {
  return [h('dt', {}, term), h('dd', {}, value)]
}

/** @param {string[]} items @param {string} [cls] */
function list(items, cls = '') {
  return items.length === 0 ? h('p', { class: 'empty' }, 'none') : h('ul', { class: `plain ${cls}` }, items.map((item) => h('li', {}, item)))
}

/**
 * @param {number} id
 * @param {(done: string) => void} onPurged
 */
function purgeSection(id, onPurged) {
  const target = { observation: id }
  const section = h('div', { class: 'purge' })
  /** @param {import('./purge-flow.js').PurgeFlow} flow @param {import('./dom.js').Child} [message] */
  const draw = (flow, message) => {
    const confirm = canConfirm(flow, target)
    replaceContent(section,
      h('h3', { class: 'label' }, 'Purge'),
      message ?? h('p', { class: 'hint' }, 'Deletes this observation, its search entry and its place in context packs. A dry run comes first.'),
      h('div', { class: 'actions' },
        confirm ? null : h('button', { type: 'button', class: 'danger-quiet', onclick: () => run(() => api('POST', '/data/purge', dryRunBody(target)), (report) => draw(previewed(target, report), h('p', { class: 'preview' }, `Dry run: would remove ${describeCounts(report.counts)}.`))) }, 'Dry run purge'),
        confirm ? h('button', { type: 'button', class: 'danger', onclick: () => run(() => api('POST', '/data/purge', confirmBody(flow, target)), (report) => onPurged(`Purged #${id}: ${describeCounts(report.counts)}.`)) }, 'Confirm purge') : null,
        confirm ? h('button', { type: 'button', class: 'quiet', onclick: () => draw(idleFlow()) }, 'Cancel') : null))
  }
  /** @param {() => Promise<unknown>} call @param {(report: import('../../data-control/purge').PurgeReport) => void} next */
  const run = (call, next) => call().then(next, (error) => draw(idleFlow(), notice(errorText(error), 'error')))
  draw(idleFlow())
  return section
}

/**
 * What a link did to the older row: an updates/contradicts link either hid it,
 * or was recorded only (the row was already hidden, or the evidence rule held).
 * @param {import('../../store/observation-links').LinkedObservation} link
 */
function linkEffect(link) {
  if (link.kind === 'confirms') return ''
  return link.applied ? 'hides it' : 'recorded only'
}

/**
 * One link as a sentence: "updates #4 title" when outgoing, "#7 title updates this" when incoming.
 * @param {import('../../store/observation-links').LinkedObservation} link
 * @param {import('./hash.js').HashState} state
 */
export function linkItem(link, state) {
  const other = h('a', { href: formatHash(withParams(state, { id: String(link.id) })) }, `#${link.id} ${link.title}`)
  const kind = h('span', { class: 'label' }, link.kind)
  const effect = linkEffect(link)
  const parts = link.direction === 'outgoing' ? [kind, ' ', other] : [other, ' ', kind, ' this']
  return h('li', {}, ...parts, ' ', evidenceBadge(link.evidence, null), effect === '' ? null : h('span', { class: 'hint' }, ` · ${effect}`))
}

/**
 * How many current observations confirm this one: incoming confirms links
 * whose source is not contradicted (the count packs and MCP rank by). A
 * detail from a store that predates confirmation counts has no `current` and counts every confirmer.
 * @param {import('../../store/observation-links').LinkedObservation[]} links
 */
export function confirmedByCount(links) {
  return links.filter((link) => link.kind === 'confirms' && link.direction === 'incoming' && link.current !== false).length
}

/**
 * @param {import('../../store/memory-reads').ObservationDetail} item from GET /memory/observations/:id
 * @param {number} now
 * @param {import('./hash.js').HashState} state
 * @param {(state: import('./hash.js').HashState) => void} navigate
 */
export function detailView(item, now, state, navigate) {
  const close = formatHash(withParams(state, { id: '' }))
  const related = item.related.map((other) => h('li', {},
    h('span', { class: 'label' }, other.relation === 'contradicted_by' ? 'contradicted by' : 'contradicts'), ' ',
    h('a', { href: formatHash(withParams(state, { id: String(other.id) })) }, `#${other.id} ${other.title}`), ' ',
    evidenceBadge(other.evidence, null)))
  const links = (item.links ?? []).map((link) => linkItem(link, state))
  return h('article', { class: 'detail', 'aria-labelledby': 'detail-title' },
    h('div', { class: 'detail-head' }, evidenceBadge(item.evidence, item.contradictedBy), h('a', { class: 'button quiet', href: close }, 'Close')),
    h('h2', { id: 'detail-title' }, item.title),
    h('p', { class: 'narrative' }, item.narrative === '' ? '(no narrative)' : item.narrative),
    h('dl', { class: 'facts-grid' },
      fact('id', h('span', { class: 'mono' }, `#${item.id}`)), fact('host', item.host), fact('type', item.type),
      fact('project', h('span', { class: 'mono' }, item.projectName ?? item.projectKey)),
      fact('session', item.sessionId === null ? '—' : `${item.sessionId} · prompt ${item.promptNumber ?? '—'}`),
      fact('observer model', h('span', { class: 'mono' }, item.observerModel ?? '—')),
      fact('confirmed by', confirmedByCount(item.links ?? []) === 0 ? 'none' : `${confirmedByCount(item.links ?? [])} current observation(s)`),
      fact('age', `${formatAge(item.occurredAt, now)} · ${formatTime(item.occurredAt)} UTC`)),
    h('h3', { class: 'label' }, 'Facts'), list(item.facts),
    h('h3', { class: 'label' }, 'Files'), list(item.files, 'mono'),
    h('h3', { class: 'label' }, 'Source events'), list(item.sourceEventIds, 'mono'),
    h('h3', { class: 'label' }, 'Contradictions'), related.length === 0 ? h('p', { class: 'empty' }, 'none') : h('ul', { class: 'plain' }, related),
    h('h3', { class: 'label' }, 'Links'), links.length === 0 ? h('p', { class: 'empty' }, 'none') : h('ul', { class: 'plain links' }, links),
    purgeSection(item.id, (message) => {
      navigate(withParams(state, { id: '', done: message }))
    }))
}

/**
 * @param {import('./hash.js').HashState} state
 * @param {{ navigate: (state: import('./hash.js').HashState) => void, now: number }} ctx
 */
export async function renderMemory(state, ctx) {
  const id = state.params.id ?? ''
  const [facets, result, item] = await Promise.all([
    api('GET', '/memory/facets'),
    api('GET', browsePath(state.params)),
    id === '' ? Promise.resolve(null) : api('GET', `/memory/observations/${encodeURIComponent(id)}`).catch((error) => ({ error: errorText(error) })),
  ])
  const rows = result.rows.map((row) => observationItem(row, ctx.now, formatHash(withParams(state, { id: String(row.id) }))))
  const detail = item === null ? null : 'error' in item ? notice(item.error, 'error') : detailView(item, ctx.now, state, ctx.navigate)
  return h('section', { class: 'page', 'aria-labelledby': 'page-title' },
    h('header', { class: 'page-head' }, h('p', { class: 'kicker' }, '02'), h('h1', { id: 'page-title' }, 'Memory')),
    state.params.done ? notice(state.params.done, 'ok') : null,
    filterForm(state, facets, ctx.navigate),
    h('div', { class: detail === null ? 'memory-layout' : 'memory-layout has-detail' },
      h('div', { class: 'memory-list' },
        rows.length === 0 ? h('p', { class: 'empty' }, 'No observations match.') : h('ol', { class: 'obs-list' }, rows),
        pager(state, result)),
      detail))
}
