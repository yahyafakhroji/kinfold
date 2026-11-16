import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { FakeElement, elements, fakeDocument, textNodes } from './fake-dom'
import { PUBLIC_DIR } from './routes'

interface Banner {
  showUpdateBanner(slot: FakeElement | null): Promise<void>
}

let answer: () => Response
let requested: { path: string; method: string }[]
let saved: { document: unknown; fetch: unknown }
beforeAll(() => {
  const globals = globalThis as Record<string, unknown>
  saved = { document: globals.document, fetch: globals.fetch }
  globals.document = fakeDocument()
  requested = []
  globals.fetch = async (path: string, init: RequestInit) => {
    requested.push({ path, method: init.method ?? 'GET' })
    return answer()
  }
})
afterAll(() => {
  const globals = globalThis as Record<string, unknown>
  globals.document = saved.document
  globals.fetch = saved.fetch
})

const load = async (): Promise<Banner> => (await import(join(PUBLIC_DIR, 'update-banner.js'))) as Banner
const shown = (slot: FakeElement): string => textNodes(slot).map((node) => node.textContent).join('')

test('the dashboard shows the banner', async () => {
  answer = () => new Response(JSON.stringify({ notice: { version: '0.2.0', message: 'Kinfold 0.2.0 is available. Run `kinfold update`.' } }))
  const slot = new FakeElement('div')
  await (await load()).showUpdateBanner(slot)
  expect(requested.at(-1)).toEqual({ path: '/update', method: 'GET' })
  expect(shown(slot)).toBe('Kinfold 0.2.0 is available. Run `kinfold update`.')
  expect(elements(slot).some((element) => element.className.includes('notice'))).toBe(true)
})

test('no notice, a failed request or a missing slot leaves the banner empty', async () => {
  const banner = await load()
  for (const make of [() => new Response(JSON.stringify({ notice: null })), () => new Response('nope', { status: 500 }), () => new Response(JSON.stringify({ notice: { message: 5 } }))]) {
    answer = make
    const slot = new FakeElement('div')
    await banner.showUpdateBanner(slot)
    expect(slot.childNodes).toHaveLength(0)
  }
  await banner.showUpdateBanner(null)
})

test('the banner shows the release on offer under the notice, with its changes and the Install button', async () => {
  answer = () => new Response(JSON.stringify({
    notice: { version: '0.6.0', message: 'Kinfold 0.6.0 is ready · 1 change · kinfold update to install' },
    release: { version: '0.6.0', changes: ['A new page.'], breaking: [], staged: true, installable: true },
  }))
  const slot = new FakeElement('div')
  await (await load()).showUpdateBanner(slot)
  expect(shown(slot)).toContain('A new page.')
  expect(elements(slot).some((element) => element.tagName === 'BUTTON')).toBe(true)
})

test('a malformed release is left out and the notice still shows', async () => {
  answer = () => new Response(JSON.stringify({ notice: { version: '0.6.0', message: 'Kinfold 0.6.0 is available.' }, release: { version: '0.6.0', changes: 'x' } }))
  const slot = new FakeElement('div')
  await (await load()).showUpdateBanner(slot)
  expect(shown(slot)).toBe('Kinfold 0.6.0 is available.')
  expect(elements(slot).some((element) => element.tagName === 'BUTTON')).toBe(false)
})
