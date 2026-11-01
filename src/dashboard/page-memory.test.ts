import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type FakeElement, elements, fakeDocument, textNodes } from './fake-dom'
import { PUBLIC_DIR } from './routes'

// The detail view's Links section, rendered into the fake DOM, which throws
// on innerHTML: every link title must arrive as a text node.
type Hash = { page: string; params: Record<string, string> }
interface MemoryModule {
  confirmedByCount(links: Record<string, unknown>[]): number
  detailView(item: Record<string, unknown>, now: number, state: Hash, navigate: (state: Hash) => void): FakeElement
  observationItem(row: Record<string, unknown>, now: number, href: string): FakeElement
}

const NOW = 1_800_000_000_000
const HOSTILE = '<img src=x onerror=alert(1)>'
let saved: unknown
beforeAll(() => {
  saved = (globalThis as Record<string, unknown>).document
  ;(globalThis as Record<string, unknown>).document = fakeDocument()
})
afterAll(() => {
  ;(globalThis as Record<string, unknown>).document = saved
})

const link = (overrides: Record<string, unknown>) => ({ id: 1, title: 't', evidence: 'tool-verified', kind: 'confirms', direction: 'outgoing', applied: false, createdAt: NOW, ...overrides })
const detail = (links: unknown[] | undefined) => ({
  id: 9, projectKey: 'k', projectName: 'repo', host: 'claude-code', type: 'discovery', evidence: 'tool-verified', title: 'Route returns 3 matches', narrative: '',
  facts: [], files: [], sourceEventIds: ['01E'], observerModel: 'm', contradictedBy: null, contradicts: [4], related: [], sessionId: 1, promptNumber: 1,
  occurredAt: NOW, createdAt: NOW, ...(links === undefined ? {} : { links }),
})
const load = async (): Promise<MemoryModule> => (await import(join(PUBLIC_DIR, 'page-memory.js'))) as MemoryModule
const linkLines = (view: FakeElement): string[] => {
  const list = elements(view).find((element) => element.className === 'plain links')
  return list === undefined ? [] : list.childNodes.map((item) => item.textContent)
}

test('the detail view lists links both ways with their kind and what they did', async () => {
  const memory = await load()
  const view = memory.detailView(detail([
    link({ id: 4, title: 'Route returns empty', evidence: 'interpretation', kind: 'contradicts', direction: 'outgoing', applied: true }),
    link({ id: 5, title: 'Spool order', kind: 'updates', direction: 'outgoing', applied: false }),
    link({ id: 12, title: 'Route still returns 3', kind: 'confirms', direction: 'incoming' }),
  ]), NOW, { page: 'memory', params: { id: '9' } }, () => {})
  expect(linkLines(view)).toEqual([
    'contradicts #4 Route returns empty interpretation · hides it',
    'updates #5 Spool order tool-verified · recorded only',
    '#12 Route still returns 3 confirms this tool-verified',
  ])
  const hrefs = elements(view).map((element) => element.getAttribute('href')).filter((href) => href?.includes('id=4') || href?.includes('id=12'))
  expect(hrefs.length).toBe(2)
})

test('a hostile link title stays one text node, and a detail without links says none', async () => {
  const memory = await load()
  const view = memory.detailView(detail([link({ id: 3, title: HOSTILE, kind: 'contradicts', direction: 'incoming', applied: true })]), NOW, { page: 'memory', params: {} }, () => {})
  expect(elements(view).map((element) => element.tagName)).not.toContain('IMG')
  expect(textNodes(view).map((node) => node.textContent)).toContain(`#3 ${HOSTILE}`)
  const empty = memory.detailView(detail(undefined), NOW, { page: 'memory', params: {} }, () => {})
  const heading = elements(empty).findIndex((element) => element.tagName === 'H3' && element.textContent === 'Links')
  expect(elements(empty)[heading + 1]?.textContent).toBe('none')
})

test('the detail counts current incoming confirmers as "confirmed by N"', async () => {
  const memory = await load()
  const links = [
    link({ id: 12, kind: 'confirms', direction: 'incoming', current: true }),
    link({ id: 13, kind: 'confirms', direction: 'incoming', current: false }),
    link({ id: 14, kind: 'confirms', direction: 'outgoing', current: true }),
    link({ id: 15, kind: 'updates', direction: 'incoming', current: true }),
  ]
  expect(memory.confirmedByCount(links)).toBe(1)
  const facts = (view: FakeElement) => elements(view).map((element) => element.textContent)
  expect(facts(memory.detailView(detail(links), NOW, { page: 'memory', params: {} }, () => {}))).toContain('1 current observation(s)')
  const none = memory.detailView(detail([]), NOW, { page: 'memory', params: {} }, () => {})
  const at = elements(none).findIndex((element) => element.tagName === 'DT' && element.textContent === 'confirmed by')
  expect(elements(none)[at + 1]?.textContent).toBe('none')
})

const listRow = (overrides: Record<string, unknown>) => ({
  id: 9, projectKey: 'org/repo', host: 'claude-code', type: 'discovery', evidence: 'tool-verified', title: 'Route returns 3 matches',
  contradictedBy: null, contradictionKind: null, occurredAt: NOW, confirmedBy: 0, ...overrides,
})
const metaTexts = (item: FakeElement): string[] => {
  const meta = elements(item).find((element) => element.className === 'obs-meta')
  return meta === undefined ? [] : meta.childNodes.map((node) => node.textContent)
}

test('a list row shows "confirmed by N" as text only when N > 0', async () => {
  const memory = await load()
  const confirmed = memory.observationItem(listRow({ confirmedBy: 2 }), NOW, '#memory?id=9')
  expect(metaTexts(confirmed)).toContain('confirmed by 2')
  expect(elements(confirmed).find((element) => element.className === 'confirmed')?.childNodes.length).toBe(1)
  for (const confirmedBy of [0, undefined]) {
    const plain = memory.observationItem(listRow({ confirmedBy }), NOW, '#memory?id=9')
    expect(metaTexts(plain).some((text) => text.startsWith('confirmed by'))).toBe(false)
    expect(elements(plain).some((element) => element.className === 'confirmed')).toBe(false)
  }
})

test('a hostile title next to a confirm count stays one text node', async () => {
  const memory = await load()
  const item = memory.observationItem(listRow({ title: HOSTILE, confirmedBy: 1 }), NOW, '#memory?id=9')
  expect(elements(item).map((element) => element.tagName)).not.toContain('IMG')
  expect(textNodes(item).map((node) => node.textContent)).toEqual(expect.arrayContaining([HOSTILE, 'confirmed by 1']))
})
