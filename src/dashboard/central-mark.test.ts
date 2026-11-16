import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { FakeElement, FakeNode, elements, fakeDocument, textNodes } from './fake-dom'
import { PUBLIC_DIR } from './routes'

interface CentralMark {
  loadCentral(): Promise<{ role: string; hub?: string; reachable?: boolean | null; problem?: string | null }>
  markBrand(slot: FakeElement | null, state: unknown): void
  hubOnly<T>(element: T): T
  applyHubOnly(root: FakeElement, state: unknown): void
}

let answer: () => Response
let saved: { document: unknown; fetch: unknown }
beforeAll(() => {
  const globals = globalThis as Record<string, unknown>
  saved = { document: globals.document, fetch: globals.fetch }
  globals.document = fakeDocument()
  globals.fetch = async () => answer()
})
afterAll(() => {
  const globals = globalThis as Record<string, unknown>
  globals.document = saved.document
  globals.fetch = saved.fetch
})

const load = async (): Promise<CentralMark> => (await import(join(PUBLIC_DIR, 'central-mark.js'))) as CentralMark
const text = (node: FakeElement): string => textNodes(node).map((each) => each.textContent).join('')
const DEVICE = { role: 'device', hub: 'mini', address: '100.64.0.2:37812', reachable: true, problem: null, queued: 0 }

test('a central device is marked with its hub in the masthead, and an unreachable hub says so', async () => {
  const mark = await load()
  answer = () => Response.json(DEVICE)
  const state = await mark.loadCentral()
  const slot = new FakeElement('span')
  mark.markBrand(slot, state)
  expect(text(slot)).toBe('127.0.0.1 · central: mini')
  mark.markBrand(slot, { ...DEVICE, reachable: false, problem: 'could not reach the hub mini' })
  expect(text(slot)).toBe('127.0.0.1 · central: mini · not reachable')
})

test('a local install, a hub, or a daemon that cannot say keeps the local mark', async () => {
  const mark = await load()
  for (const make of [() => Response.json({ role: 'local' }), () => Response.json({ role: 'hub', devices: [] }), () => new Response('x', { status: 404 })]) {
    answer = make
    const slot = new FakeElement('span')
    slot.appendChild(new FakeNode(3, '127.0.0.1 · local only'))
    mark.markBrand(slot, await mark.loadCentral())
    expect(text(slot)).toBe('127.0.0.1 · local only')
  }
})

test('on a central device every hub-only block is disabled as one, with "run this on the hub"', async () => {
  const mark = await load()
  const root = new FakeElement('section')
  const block = mark.hubOnly(new FakeElement('section'))
  const title = new FakeElement('h2')
  title.className = 'block-title'
  const button = new FakeElement('button')
  block.appendChild(title)
  block.appendChild(button)
  root.appendChild(block)
  const local = new FakeElement('section')
  local.appendChild(new FakeElement('button'))
  root.appendChild(local)

  mark.applyHubOnly(root, DEVICE)
  const fieldset = elements(block).find((element) => element.tagName === 'FIELDSET')!
  expect(fieldset.getAttribute('disabled')).toBe('')
  expect(fieldset.childNodes).toContain(button)
  expect(block.childNodes[0]).toBe(title)
  expect(text(block)).toContain('Run this on the hub (mini): this device uses central memory.')
  expect(elements(local).some((element) => element.tagName === 'FIELDSET')).toBe(false)

  const untouched = mark.hubOnly(new FakeElement('section'))
  untouched.appendChild(new FakeElement('button'))
  mark.applyHubOnly(untouched, { role: 'local' })
  expect(elements(untouched).some((element) => element.tagName === 'FIELDSET')).toBe(false)
})
