import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type FakeElement, type FakeNode, elements, fakeDocument, textNodes } from './fake-dom'
import { PUBLIC_DIR } from './routes'

// The page scripts are plain JS with no type declarations, so tests load them
// by path and describe the parts they call.
type Row = { id: number; projectKey: string; host: string; type: string; evidence: string; title: string; contradictedBy: number | null; occurredAt: number }
type Hash = { page: string; params: Record<string, string> }
type Flow = { stage: string }
interface MemoryModule {
  observationItem(row: Row, now: number, href: string): FakeElement
  detailView(item: Record<string, unknown>, now: number, state: Hash, navigate: (state: Hash) => void): FakeElement
  browsePath(params: Record<string, string>): string
}
interface DomModule { h(tag: string, props?: Record<string, unknown>, ...children: unknown[]): FakeElement }
interface FlowModule {
  idleFlow(): Flow
  previewed(target: Record<string, unknown>, report: { dryRun: boolean; counts: Record<string, number> }): Flow
  canConfirm(flow: Flow, target: Record<string, unknown>): boolean
  confirmBody(flow: Flow, target: Record<string, unknown>): Record<string, unknown>
  dryRunBody(target: Record<string, unknown>): Record<string, unknown>
  describeCounts(counts: Record<string, number>): string
}
interface HashModule { parseHash(hash: string): Hash; formatHash(state: Hash): string; withParams(state: Hash, changes: Record<string, string>): Hash }
interface DataModule {
  purgeTarget(data: { get(name: string): string | null }): { ok: boolean; target?: Record<string, unknown>; error?: string }
  retentionBody(data: { get(name: string): string | null }): unknown
}

const load = async <T>(name: string): Promise<T> => (await import(join(PUBLIC_DIR, name))) as T
const XSS = ['<img src=x onerror=alert(1)>', '</script><script>alert(document.cookie)</script>', '"><svg onload=alert(1)>', 'javascript:alert(1)'] as const
const NOW = 1_800_000_000_000

let saved: unknown
beforeAll(() => {
  saved = (globalThis as Record<string, unknown>).document
  ;(globalThis as Record<string, unknown>).document = fakeDocument()
})
afterAll(() => {
  ;(globalThis as Record<string, unknown>).document = saved
})

const tags = (root: FakeNode): string[] => elements(root).map((element) => element.tagName)

test('a hostile title renders as one text node, not as markup', async () => {
  const memory = await load<MemoryModule>('page-memory.js')
  for (const title of XSS) {
    const item = memory.observationItem({ id: 7, projectKey: '<b>p</b>', host: '<i>h</i>', type: 'discovery', evidence: 'tool-verified', title, contradictedBy: null, occurredAt: NOW }, NOW, '#memory?id=7')
    expect(tags(item)).not.toContain('IMG')
    expect(tags(item)).not.toContain('SCRIPT')
    expect(tags(item)).not.toContain('SVG')
    const link = elements(item).find((element) => element.className === 'obs-title')!
    expect(link.childNodes.map((child) => child.nodeType)).toEqual([3])
    expect(link.textContent).toBe(title)
    expect(textNodes(item).map((node) => node.textContent)).toContain('<b>p</b>')
  }
})

test('the detail view keeps narrative, facts, files and linked titles as text', async () => {
  const memory = await load<MemoryModule>('page-memory.js')
  const item = {
    id: 9, projectKey: 'k', projectName: XSS[2], host: 'claude-code', type: 'bugfix', evidence: 'interpretation', title: XSS[0], narrative: XSS[1],
    facts: [XSS[0], XSS[1]], files: [XSS[2]], sourceEventIds: ['01EVENT'], observerModel: XSS[3], contradictedBy: 4, contradicts: [],
    related: [{ id: 4, title: XSS[1], evidence: 'tool-verified', relation: 'contradicted_by' }], sessionId: 1, promptNumber: 2, occurredAt: NOW, createdAt: NOW,
  }
  const view = memory.detailView(item, NOW, { page: 'memory', params: { id: '9' } }, () => {})
  expect(tags(view).filter((tag) => ['IMG', 'SCRIPT', 'SVG'].includes(tag))).toEqual([])
  const texts = textNodes(view).map((node) => node.textContent)
  for (const value of [XSS[0], XSS[1], XSS[2], XSS[3], `#4 ${XSS[1]}`]) expect(texts).toContain(value)
  const badge = elements(view).find((element) => element.className.startsWith('badge'))!
  expect(badge.textContent).toBe('contradicted')
  for (const element of elements(view)) {
    const href = element.getAttribute('href')
    if (href !== null) expect(href).toMatch(/^[#/]/)
  }
})

test('h() never sets a script URL or a string event handler', async () => {
  const dom = await load<DomModule>('dom.js')
  const link = dom.h('a', { href: 'javascript:alert(1)', onclick: 'alert(1)', onmouseover: 'x', title: '<x>' }, '<b>t</b>')
  expect(link.getAttribute('href')).toBeNull()
  expect(link.getAttribute('onclick')).toBeNull()
  expect(link.getAttribute('onmouseover')).toBeNull()
  expect(link.getAttribute('title')).toBe('<x>')
  expect(link.childNodes.map((child) => child.nodeType)).toEqual([3])
  expect(dom.h('a', { href: '#memory?id=1' }).getAttribute('href')).toBe('#memory?id=1')
})

const SOURCES = readdirSync(PUBLIC_DIR).map((name) => ({ name, text: readFileSync(join(PUBLIC_DIR, name), 'utf8') }))

test('no asset uses an HTML parser, eval, web storage or inline style', () => {
  for (const { name, text } of SOURCES.filter((source) => source.name.endsWith('.js'))) {
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'localStorage', 'sessionStorage', "setAttribute('style'", '.style.', 'createContextualFragment', 'DOMParser']) {
      expect({ name, banned, found: text.includes(banned) }).toEqual({ name, banned, found: false })
    }
  }
})

test('the HTML pages have no inline script, inline style, handler attribute or external origin', () => {
  for (const { name, text } of SOURCES.filter((source) => source.name.endsWith('.html'))) {
    const scripts = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    expect(scripts.length).toBeGreaterThan(0)
    for (const script of scripts) {
      expect(script[0]).toMatch(/src="\/dashboard\/assets\/[a-z-]+\.js"/)
      expect(script[1]!.trim()).toBe('')
    }
    expect({ name, style: /<style\b|\sstyle=/.test(text) }).toEqual({ name, style: false })
    expect({ name, handler: /\son[a-z]+=/i.test(text) }).toEqual({ name, handler: false })
    expect({ name, external: /(src|href)="(https?:)?\/\//.test(text) }).toEqual({ name, external: false })
  }
})

test('the stylesheet uses system fonts only and themes through custom properties', () => {
  const css = SOURCES.find((source) => source.name === 'app.css')!.text
  expect(css).not.toContain('@font-face')
  expect(css).not.toContain('@import')
  expect(css).not.toMatch(/url\(/)
  expect(css).toContain('@media (prefers-color-scheme: dark)')
  expect(css).toContain('--ev-verified')
  expect(css).toContain(':focus-visible')
})

test('a purge confirms only for the exact target its dry run showed', async () => {
  const flow = await load<FlowModule>('purge-flow.js')
  const target = { session: 7 }
  const idle = flow.idleFlow()
  expect(flow.canConfirm(idle, target)).toBe(false)
  expect(() => flow.confirmBody(idle, target)).toThrow('run a dry run for this target first')
  expect(flow.dryRunBody(target)).toEqual({ session: 7, dryRun: true })
  expect(() => flow.previewed(target, { dryRun: false, counts: {} })).toThrow()

  const shown = flow.previewed(target, { dryRun: true, counts: { events: 12, observations: 3, sessions: 0 } })
  expect(flow.canConfirm(shown, target)).toBe(true)
  expect(flow.canConfirm(shown, { session: 8 })).toBe(false)
  expect(flow.canConfirm(shown, { session: 7, after: 'x' })).toBe(false)
  expect(() => flow.confirmBody(shown, { session: 8 })).toThrow()
  expect(flow.confirmBody(shown, { session: 7 })).toEqual({ session: 7, dryRun: false })
  expect(flow.describeCounts({ events: 12, observations: 3, sessions: 0 })).toBe('events 12, observations 3')
  const range = flow.previewed({ before: 'b', after: 'a' }, { dryRun: true, counts: {} })
  expect(flow.canConfirm(range, { after: 'a', before: 'b' })).toBe(true)
})

test('the data page builds purge targets and retention bodies from its forms', async () => {
  const data = await load<DataModule>('page-data.js')
  const form = (values: Record<string, string>): { get(name: string): string | null } => ({ get: (name) => values[name] ?? null })
  expect(data.purgeTarget(form({ kind: 'session', value: '12' }))).toEqual({ ok: true, target: { session: 12 } })
  expect(data.purgeTarget(form({ kind: 'session', value: 'x' }))).toEqual({ ok: false, error: 'enter a session id' })
  expect(data.purgeTarget(form({ kind: 'project', value: ' org/a ' }))).toEqual({ ok: true, target: { project: 'org/a' } })
  expect(data.purgeTarget(form({ kind: 'host', value: '' }))).toEqual({ ok: false, error: 'enter a host' })
  expect(data.purgeTarget(form({ kind: 'range', before: '2026-10-01T00:00:00Z', after: '2026-09-01T00:00:00Z' })))
    .toEqual({ ok: true, target: { after: '2026-09-01T00:00:00.000Z', before: '2026-10-01T00:00:00.000Z' } })
  expect(data.purgeTarget(form({ kind: 'range' }))).toEqual({ ok: false, error: 'enter the end of the range' })
  expect(data.retentionBody(form({ events: '14', prompts: '', observations: '', summaries: '365', warnMb: '256' })))
    .toEqual({ retention: { events: 14, prompts: null, observations: null, summaries: 365 }, warnBytes: 268_435_456 })
})

test('the hash holds page, filters and page number, and survives a round trip', async () => {
  const hash = await load<HashModule>('hash.js')
  const memory = await load<MemoryModule>('page-memory.js')
  const state = hash.parseHash('#memory?host=opencode&page=3&q=fts%20sanitizer')
  expect(state).toEqual({ page: 'memory', params: { host: 'opencode', page: '3', q: 'fts sanitizer' } })
  expect(hash.parseHash(hash.formatHash(state))).toEqual(state)
  expect(hash.parseHash('#nonsense')).toEqual({ page: 'memory', params: {} })
  expect(hash.parseHash('')).toEqual({ page: 'memory', params: {} })
  expect(hash.withParams(state, { evidence: 'contradicted' })).toEqual({ page: 'memory', params: { host: 'opencode', page: '', q: 'fts sanitizer', id: '', done: '', evidence: 'contradicted' } })
  expect(hash.formatHash(hash.withParams(state, { evidence: 'contradicted' }))).toBe('#memory?evidence=contradicted&host=opencode&q=fts+sanitizer')
  expect(hash.formatHash(hash.withParams(state, { id: '5' }))).toBe('#memory?host=opencode&id=5&page=3&q=fts+sanitizer')
  expect(memory.browsePath({ host: 'opencode', page: '3', id: '5', q: 'a&b' })).toBe('/memory/observations?host=opencode&q=a%26b&page=3')
})

test('the login script drops the code from the URL, posts it with our header, then opens the app', async () => {
  const calls: { replaced: string[]; navigated: string[]; fetched: { url: string; init: RequestInit }[] } = { replaced: [], navigated: [], fetched: [] }
  const globals = globalThis as Record<string, unknown>
  const previous = { location: globals.location, history: globals.history, fetch: globals.fetch }
  globals.location = { hash: '#code=abc_DEF-123', replace: (url: string) => calls.navigated.push(url) }
  globals.history = { replaceState: (_s: unknown, _t: string, url: string) => calls.replaced.push(url) }
  globals.fetch = async (url: string, init: RequestInit) => {
    calls.fetched.push({ url, init })
    return new Response(null, { status: 204 })
  }
  try {
    await import(`${join(PUBLIC_DIR, 'login.js')}?run=1`)
    await Bun.sleep(10)
  } finally {
    Object.assign(globals, previous)
  }
  expect(calls.replaced).toEqual(['/dashboard/login'])
  expect(calls.fetched).toHaveLength(1)
  expect(calls.fetched[0]!.url).toBe('/dashboard/session')
  expect(calls.fetched[0]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'x-sam-request': '1' }, body: '{"code":"abc_DEF-123"}' })
  expect(calls.navigated).toEqual(['/dashboard/'])
})
