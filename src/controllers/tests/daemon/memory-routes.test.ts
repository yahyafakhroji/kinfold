import { afterEach, beforeEach, expect, test } from 'bun:test'
import { contradict, seedObservation } from '../context/test-support'
import { type Fixture, MARKERS, seedFixture } from '../data-control/test-support'
import { type DashboardRig, startRig } from '../dashboard/test-support'
import { parseSearchQuery } from '../mcp/fts'
import { T0, seedEvent } from '../observer/test-support'
import { insertLinks, settleContradictions } from '../store/observation-links'
import { PAGE_SIZE, parseBrowseQuery } from './memory-routes'

type Facet = { value: string; label: string; observations: number }

const PAYLOAD_MARKER = 'qxpayloadonlymarker'
const MINUTE = 60_000

let fixture: Fixture
let rig: DashboardRig
let bulk: number[]

beforeEach(() => {
  fixture = seedFixture('sam-memory-routes-')
  const { store } = fixture.temp
  seedEvent(store, fixture.sessions.a1, { kind: 'tool_result', at: T0 + 5, promptNumber: 1, tool: { name: 'Bash', output: `${PAYLOAD_MARKER} in a payload`, exitCode: 0 } })
  bulk = Array.from({ length: 60 }, (_, index) =>
    seedObservation(store, { sessionId: fixture.sessions.a1, projectKey: fixture.projectA, host: 'claude-code', title: `Bulk note ${index}`, at: T0 + 10 * MINUTE + index * MINUTE }))
  store.db.query("UPDATE observations SET evidence = 'interpretation', type = 'decision' WHERE id = $id").run({ id: bulk[0]! })
  contradict(store, fixture.observations.a1, bulk[1]!)
  rig = startRig(fixture.temp.dataDir)
})
afterEach(async () => {
  await rig.stop()
  fixture.temp.cleanup()
})

interface Page {
  rows: { id: number; title: string; host: string; projectKey: string; occurredAt: number }[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

async function browse(query: string): Promise<Page> {
  const response = await rig.bearer('GET', `/memory/observations${query}`)
  expect(response.status).toBe(200)
  return (await response.json()) as Page
}

test('newest first, 50 per page, with a total and hasMore', async () => {
  const first = await browse('')
  expect(first).toMatchObject({ total: 63, page: 1, pageSize: PAGE_SIZE, hasMore: true })
  expect(first.rows).toHaveLength(50)
  expect(first.rows.slice(0, 3).map((row) => row.id)).toEqual([fixture.observations.b1, fixture.observations.a2, bulk[59]!])
  const times = first.rows.map((row) => row.occurredAt)
  expect(times).toEqual([...times].sort((a, b) => b - a))
  const second = await browse('?page=2')
  expect(second).toMatchObject({ total: 63, page: 2, hasMore: false })
  expect(second.rows.map((row) => row.id)).toEqual([...bulk.slice(0, 12).reverse(), fixture.observations.a1])
  expect((await browse('?page=3')).rows).toEqual([])
})

test('project, host, type and evidence filters, alone and combined', async () => {
  expect((await browse(`?project=${encodeURIComponent(fixture.projectB)}`)).rows.map((row) => row.id)).toEqual([fixture.observations.b1])
  expect((await browse('?host=opencode')).rows.map((row) => row.id)).toEqual([fixture.observations.a2])
  expect((await browse('?type=decision')).rows.map((row) => row.id)).toEqual([bulk[0]!])
  expect((await browse('?evidence=interpretation')).rows.map((row) => row.id)).toEqual([bulk[0]!])
  expect((await browse('?evidence=contradicted')).rows.map((row) => row.id)).toEqual([fixture.observations.a1])
  expect((await browse(`?host=claude-code&project=${encodeURIComponent(fixture.projectA)}&page=2`)).total).toBe(61)
  expect((await browse('?host=&type=&evidence=&q=')).total).toBe(63)
})

test('full-text search goes through the MCP sanitizer, so FTS syntax is literal', async () => {
  expect((await browse(`?q=${MARKERS.b1}`)).rows.map((row) => row.id)).toEqual([fixture.observations.b1])
  expect((await browse(`?q=${encodeURIComponent(`bulk note`)}&host=claude-code`)).total).toBe(60)
  for (const q of [`${MARKERS.a1} OR ${MARKERS.b1}`, 'NEAR(bulk note)', 'bulk*', 'title:bulk', '"bulk', '^bulk']) {
    const response = await rig.bearer('GET', `/memory/observations?q=${encodeURIComponent(q)}`)
    expect({ q, status: response.status }).toEqual({ q, status: 200 })
  }
  expect((await browse(`?q=${encodeURIComponent(`${MARKERS.a1} OR ${MARKERS.b1}`)}`)).total).toBe(0)
  const empty = await rig.bearer('GET', `/memory/observations?q=${encodeURIComponent('*** ""')}`)
  expect(empty.status).toBe(400)
  const reference = parseSearchQuery('*** ""')
  expect(await empty.json()).toEqual({ error: `q: ${reference.ok ? '' : reference.error}` })
  const parsed = parseBrowseQuery(new URLSearchParams({ q: 'a"b OR c' }))
  expect(parsed.ok && parsed.value.filters.match).toBe('"a""b" "OR" "c"')
})

test('bad parameters are 400 and name the parameter, never echo it', async () => {
  for (const query of ['?evidence=strong', '?type=essay', '?host=Evil%20Host', '?page=0', '?page=1001', '?page=two', '?sort=asc', `?project=${'x'.repeat(600)}`]) {
    const response = await rig.bearer('GET', `/memory/observations${query}`)
    expect({ query, status: response.status }).toEqual({ query, status: 400 })
    const text = await response.text()
    expect(text).not.toContain('strong')
    expect(text).not.toContain('Evil')
  }
  expect((await rig.bearer('POST', '/memory/observations')).status).toBe(405)
  expect((await rig.bearer('GET', '/memory/other')).status).toBe(404)
})

test('detail shows provenance and contradictions both ways; unknown ids are 404', async () => {
  const response = await rig.bearer('GET', `/memory/observations/${fixture.observations.a1}`)
  expect(response.status).toBe(200)
  const detail = (await response.json()) as Record<string, unknown>
  expect(detail).toMatchObject({
    id: fixture.observations.a1, host: 'claude-code', type: 'discovery', evidence: 'tool-verified', projectKey: fixture.projectA, projectName: 'alpha',
    sessionId: fixture.sessions.a1, promptNumber: 1, observerModel: 'fake-model', facts: [], files: [], sourceEventIds: [], contradictedBy: bulk[1]!,
    createdAt: T0, occurredAt: T0,
  })
  expect(detail.related).toEqual([{ id: bulk[1]!, title: 'Bulk note 1', evidence: 'tool-verified', relation: 'contradicted_by' }])
  const newer = (await (await rig.bearer('GET', `/memory/observations/${bulk[1]!}`)).json()) as { contradicts: number[]; related: { relation: string }[] }
  expect(newer.contradicts).toEqual([fixture.observations.a1])
  expect(newer.related.map((other) => other.relation)).toEqual(['contradicts'])
  expect((await rig.bearer('GET', '/memory/observations/999999')).status).toBe(404)
  expect((await rig.bearer('GET', '/memory/observations/abc')).status).toBe(404)
})

test('facets list projects, hosts and types with counts', async () => {
  const facets = (await (await rig.bearer('GET', '/memory/facets')).json()) as { projects: Facet[]; hosts: Facet[]; types: Facet[] }
  expect(facets.projects).toEqual([{ value: fixture.projectA, label: 'alpha', observations: 62 }, { value: fixture.projectB, label: 'beta', observations: 1 }])
  expect(facets.hosts).toEqual([{ value: 'claude-code', label: 'claude-code', observations: 62 }, { value: 'opencode', label: 'opencode', observations: 1 }])
  expect(facets.types.map((type) => type.value)).toEqual(['discovery', 'decision'])
})

test('no answer carries an event payload, and the log holds counts only', async () => {
  const answers = await Promise.all([
    '/memory/observations', `/memory/observations?q=${MARKERS.a1}`, `/memory/observations/${fixture.observations.a1}`, '/memory/facets',
  ].map(async (path) => (await rig.bearer('GET', path)).text()))
  for (const text of answers) expect(text).not.toContain(PAYLOAD_MARKER)
  const log = rig.logs.filter((line) => line.startsWith('memory browse'))
  expect(log.length).toBeGreaterThan(0)
  for (const line of log) expect(line).toMatch(/^memory browse rows=\d+ total=\d+ search=(true|false) ms=\d+$/)
})

test('detail lists observation links both ways with their kind, and whether each one hides its target', async () => {
  const { db } = fixture.temp.store
  insertLinks(db, bulk[3]!, [{ kind: 'updates', observationId: bulk[2]! }, { kind: 'confirms', observationId: bulk[4]! }], T0)
  insertLinks(db, bulk[5]!, [{ kind: 'contradicts', observationId: bulk[2]! }], T0)
  settleContradictions(db, [bulk[2]!])
  const target = (await (await rig.bearer('GET', `/memory/observations/${bulk[2]!}`)).json()) as { contradictedBy: number; links: Record<string, unknown>[] }
  expect(target.contradictedBy).toBe(bulk[3]!)
  expect(target.links.map(({ id, kind, direction, applied }) => ({ id, kind, direction, applied }))).toEqual([
    { id: bulk[3]!, kind: 'updates', direction: 'incoming', applied: true },
    { id: bulk[5]!, kind: 'contradicts', direction: 'incoming', applied: false },
  ])
  const source = (await (await rig.bearer('GET', `/memory/observations/${bulk[3]!}`)).json()) as { links: Record<string, unknown>[] }
  expect(source.links.map(({ id, kind, direction }) => ({ id, kind, direction }))).toEqual([
    { id: bulk[2]!, kind: 'updates', direction: 'outgoing' },
    { id: bulk[4]!, kind: 'confirms', direction: 'outgoing' },
  ])
  expect(JSON.stringify(target)).not.toContain(PAYLOAD_MARKER)
})
