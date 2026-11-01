// Metrics from GET /metrics/summary, only what the store records today:
// observer runs per host and provider, injections per host and channel,
// capture-to-searchable lag, latency stages with lag from event and from turn
// end over a window (#metrics?window=24h|7d), injection latency per host and
// channel, two hit-rate proxies (P1-H), and the event queue by observer state.
// Bars are <meter> elements so no inline style is needed (the CSP forbids it).

import { api } from './api.js'
import { h, table } from './dom.js'
import { formatDuration, formatPercent } from './format.js'
import { formatHash, withParams } from './hash.js'

/** @param {Record<string, number>} classes */
export function errorClassList(classes) {
  const entries = Object.entries(classes).sort(([, a], [, b]) => b - a)
  return entries.length === 0 ? h('span', { class: 'hint' }, 'none') : entries.map(([name, n]) => h('span', { class: 'badge run-failed' }, `${name} ${n}`))
}

/** @param {number | null} rate */
function rateCell(rate) {
  const tone = rate === null ? 'quiet' : rate >= 0.9 ? 'run-ok' : rate >= 0.5 ? 'run-warn' : 'run-failed'
  return h('span', { class: `badge ${tone}` }, formatPercent(rate))
}

/** @param {import('../metrics').MetricsSummary} summary */
function runsBlock(summary) {
  return h('section', { class: 'block', 'aria-label': 'Observer runs' },
    h('h2', { class: 'block-title' }, h('span', { class: 'kicker' }, 'A'), ' Observer runs'),
    h('p', { class: 'hint' }, 'Most recent 5,000 runs, by host and provider. Durations count finished runs.'),
    table('Observer runs', ['Host', 'Provider', 'Runs', 'Success', 'p50', 'p95', 'Error classes'], summary.runs.map((group) => [
      h('span', { class: 'host' }, group.host), h('span', { class: 'mono' }, group.provider),
      `${group.runs}${group.running > 0 ? ` (${group.running} running)` : ''}`, rateCell(group.successRate),
      formatDuration(group.durationMs.p50), formatDuration(group.durationMs.p95), h('div', { class: 'badges' }, errorClassList(group.errorClasses))]), 'No observer runs recorded yet.'))
}

/** @param {import('../metrics').MetricsSummary} summary */
function injectionsBlock(summary) {
  return h('section', { class: 'block', 'aria-label': 'Injections' },
    h('h2', { class: 'block-title' }, h('span', { class: 'kicker' }, 'B'), ' Injections'),
    table('Injections', ['Host', 'Channel', 'Count', 'Tokens', 'Tokens / injection'], summary.injections.map((row) => [
      h('span', { class: 'host' }, row.host), h('span', { class: 'mono' }, row.channel), String(row.count), String(row.tokens),
      row.count === 0 ? '—' : String(Math.round(row.tokens / row.count))]), 'Nothing injected yet.'))
}

/** @param {import('../metrics').MetricsSummary} summary */
function lagBlock(summary) {
  const lag = summary.captureLagMs
  return h('section', { class: 'block', 'aria-label': 'Capture to searchable' },
    h('h2', { class: 'block-title' }, h('span', { class: 'kicker' }, 'C'), ' Capture to searchable'),
    h('div', { class: 'figures' },
      h('p', { class: 'figure' }, h('span', { class: 'figure-label' }, 'p50'), h('span', { class: 'figure-value' }, formatDuration(lag.p50))),
      h('p', { class: 'figure' }, h('span', { class: 'figure-label' }, 'p95'), h('span', { class: 'figure-value' }, formatDuration(lag.p95))),
      h('p', { class: 'figure' }, h('span', { class: 'figure-label' }, 'observations'), h('span', { class: 'figure-value' }, String(lag.samples)))),
    h('p', { class: 'hint' }, 'From the newest event an observation cites (occurred_at) to the observation row (created_at). Target: 30 s.'))
}

/** @param {import('../metrics').MetricsSummary} summary */
function queueBlock(summary) {
  const total = summary.queue.reduce((sum, row) => sum + row.events, 0)
  return h('section', { class: 'block', 'aria-label': 'Queue' },
    h('h2', { class: 'block-title' }, h('span', { class: 'kicker' }, 'D'), ' Queue'),
    summary.queue.length === 0 ? h('p', { class: 'empty' }, 'No events stored.') : h('ul', { class: 'bars' }, summary.queue.map((row) => h('li', {},
      h('span', { class: `state state-${row.state}` }, row.state),
      h('meter', { min: 0, max: total, value: row.events, 'aria-label': `${row.state} events` }),
      h('span', { class: 'mono' }, String(row.events))))))
}

export const WINDOWS = ['24h', '7d']

/** @param {import('./hash.js').HashState} state */
export function windowOf(state) {
  const window = state.params.window ?? ''
  return WINDOWS.includes(window) ? window : WINDOWS[0]
}

/** @param {import('./hash.js').HashState} state */
function windowLinks(state) {
  const current = windowOf(state)
  return h('nav', { class: 'badges', 'aria-label': 'Latency window' }, WINDOWS.map((window) => h('a', {
    href: formatHash(withParams(state, { window })), class: `badge ${window === current ? 'run-ok' : 'quiet'}`,
    ...(window === current ? { 'aria-current': 'page' } : {}),
  }, `last ${window}`)))
}

/** @param {import('../metrics').Percentiles} p */
const durationPair = (p) => [formatDuration(p.p50), formatDuration(p.p95)]

/** @param {import('../metrics').StagePercentiles} s */
function stageCells(s) {
  return [...durationPair(s.ingestMs), ...durationPair(s.schedulerMs), ...durationPair(s.runMs), ...durationPair(s.writeMs)]
}

/**
 * @param {string} label
 * @param {number | null} ms
 */
const figure = (label, ms) => h('p', { class: 'figure' }, h('span', { class: 'figure-label' }, label), h('span', { class: 'figure-value' }, formatDuration(ms)))

/**
 * Stages of capture-to-searchable and the two lag numbers, overall and per host and provider.
 * @param {import('../metrics').MetricsSummary} summary
 * @param {import('./hash.js').HashState} state
 */
export function latencyBlock(summary, state) {
  const latency = summary.latency
  const turn = latency.all.lagFromTurnEndMs
  const event = latency.all.lagFromEventMs
  const groups = [{ host: 'all', provider: '', ...latency.all }, ...latency.groups]
  return h('section', { class: 'block', 'aria-label': 'Latency' },
    h('h2', { class: 'block-title' }, h('span', { class: 'kicker' }, 'E'), ' Latency'),
    windowLinks(state),
    h('div', { class: 'figures' },
      figure('from turn end p50', turn.p50), figure('from turn end p95', turn.p95),
      figure('from event p50', event.p50), figure('from event p95', event.p95)),
    h('p', { class: 'hint' }, `Last ${latency.window}. From turn end: a turn_end to the first observer run that finished after it (target p95 30 s, ${turn.samples} turns). From event: each cited event to its observation (${event.samples} events).`),
    table('Latency stages', ['Host', 'Provider', 'Ingest p50', 'p95', 'Waiting p50', 'p95', 'Run p50', 'p95', 'Write p50', 'p95', 'Turn end p95'], groups.map((group) => [
      h('span', { class: 'host' }, group.host), h('span', { class: 'mono' }, group.provider), ...stageCells(group), formatDuration(group.lagFromTurnEndMs.p95)]), 'No observed events in this window.'),
    h('h3', { class: 'block-title' }, 'Context injection'),
    table('Injection latency', ['Host', 'Channel', 'Injections', 'p50', 'p95'], summary.injectionLatency.map((row) => [
      h('span', { class: 'host' }, row.host), h('span', { class: 'mono' }, row.channel), String(row.durationMs.samples),
      formatDuration(row.durationMs.p50), formatDuration(row.durationMs.p95)]), 'No timed injections in this window.'),
    h('p', { class: 'hint' }, 'Daemon time to build or match what it served (pack or prompt delta), before the audit write. The read-only fallback is not timed.'))
}

/**
 * @param {string} label
 * @param {number | null} rate
 * @param {string} detail
 */
const rateFigure = (label, rate, detail) => h('p', { class: 'figure' }, h('span', { class: 'figure-label' }, label),
  h('span', { class: 'figure-value' }, formatPercent(rate)), h('span', { class: 'hint' }, detail))

/**
 * Hit rate, labelled as the proxy it is: what was fetched or found, not what was used.
 * @param {import('../metrics').MetricsSummary} summary
 */
export function usageBlock(summary) {
  const { fetchAfterInject: fetched, searchHit: search, reads } = summary.hitRate
  return h('section', { class: 'block', 'aria-label': 'Memory use' },
    h('h2', { class: 'block-title' }, h('span', { class: 'kicker' }, 'F'), ' Memory use (proxies)'),
    h('div', { class: 'figures' },
      rateFigure('fetch after inject', fetched.rate, `${fetched.fetched} of ${fetched.injected} injected ids`),
      rateFigure('search hit', search.rate, `${search.withRows} of ${search.searches} searches`)),
    h('p', { class: 'hint' }, `Last ${summary.hitRate.window}. Fetch after inject: the share of observation ids injected in a project that an MCP get_observations call in that project returned within 24 h. Search hit: the share of MCP searches that returned at least one row.`),
    h('p', { class: 'hint' }, 'These are proxies, not usage. An agent can act on an injected line without fetching it, and can fetch an id it found by searching. Reads count only from MCP servers that report to this daemon.'),
    table('MCP reads', ['Host', 'Tool', 'Calls', 'Errors'], reads.map((row) => [
      h('span', { class: 'host' }, row.host), h('span', { class: 'mono' }, row.tool), String(row.calls), String(row.errors)]), 'No MCP reads reported in this window.'),
    table('Related lines by distance', ['Distance', 'Served', 'Fetched', 'Rate'], (summary.hitRate.relatedByDistance ?? []).map((row) => [
      h('span', { class: 'mono' }, row.band), String(row.served), String(row.fetched), formatPercent(row.rate)]), 'No related lines served in this window.'),
    h('p', { class: 'hint' }, 'Related lines served at prompt time, by the distance that let them through the gate, and the share an MCP get_observations call in the project returned within 24 h. The same proxy as above, kept per band so the cutoffs can be checked against use.'))
}

/** @param {import('./hash.js').HashState} [state] */
export async function renderMetrics(state = { page: 'metrics', params: {} }) {
  const summary = await api('GET', `/metrics/summary?window=${encodeURIComponent(windowOf(state))}`)
  return h('section', { class: 'page', 'aria-labelledby': 'page-title' },
    h('header', { class: 'page-head' }, h('p', { class: 'kicker' }, '04'), h('h1', { id: 'page-title' }, 'Metrics'),
      h('p', { class: 'lede' }, 'Measured from what the store already records.')),
    runsBlock(summary), injectionsBlock(summary), lagBlock(summary), latencyBlock(summary, state), usageBlock(summary), queueBlock(summary))
}
