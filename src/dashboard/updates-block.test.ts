import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type FakeElement, elements, fakeDocument } from './fake-dom'
import { EMBEDDED_ASSET_NAMES, PUBLIC_DIR } from './routes'

// The Updates block on the data page: whether patch releases install
// themselves, the switch, the last update and the last error. Text only.

interface Auto {
  on: boolean
  reason: string | null
  lastError: { version: string; at: number; reason: string; blocked?: true } | null
  lastUpdate: { version: string; previous: string; at: number } | null
}
type Sent = { method: string; path: string; body: unknown }
interface BlockModule {
  updatesBlock(auto: Auto | null, deps: { send(method: string, path: string, body: unknown): Promise<unknown> }): FakeElement
}

const ON: Auto = { on: true, reason: null, lastError: null, lastUpdate: null }
const OFF: Auto = { on: false, reason: 'turned off', lastError: null, lastUpdate: null }
const AT = 1_800_000_000_000

let saved: unknown
beforeAll(() => {
  saved = (globalThis as Record<string, unknown>).document
  ;(globalThis as Record<string, unknown>).document = fakeDocument()
})
afterAll(() => {
  ;(globalThis as Record<string, unknown>).document = saved
})

const load = async (): Promise<BlockModule> => (await import(join(PUBLIC_DIR, 'updates-block.js'))) as BlockModule
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const fire = (element: FakeElement, type: string): void => {
  for (const listener of element.listeners.get(type) ?? []) listener({ preventDefault: () => {} })
}
const button = (block: FakeElement): FakeElement | undefined => elements(block).find((element) => element.tagName === 'BUTTON')

function mount(page: BlockModule, auto: Auto | null, answer: (body: unknown) => Promise<unknown> = async () => ({ auto: OFF })) {
  const sent: Sent[] = []
  const block = page.updatesBlock(auto, { send: (method, path, body) => (sent.push({ method, path, body }), answer(body)) })
  return { block, sent }
}

test('on: the block says so and offers to turn it off', async () => {
  const { block } = mount(await load(), ON)
  expect(block.textContent).toContain('Patch releases install themselves.')
  expect(button(block)?.textContent).toBe('Turn off')
})

test('Turn off sends the switch and shows the saved state with a Turn on button', async () => {
  const { block, sent } = mount(await load(), ON)
  fire(button(block)!, 'click')
  await flush()
  expect(sent).toEqual([{ method: 'PUT', path: '/update/auto', body: { enabled: false } }])
  expect(block.textContent).toContain('Patch releases are not installed automatically.')
  expect(button(block)?.textContent).toBe('Turn on')
})

test('Turn on sends enabled: true', async () => {
  const { block, sent } = mount(await load(), OFF, async () => ({ auto: ON }))
  fire(button(block)!, 'click')
  await flush()
  expect(sent[0]?.body).toEqual({ enabled: true })
  expect(block.textContent).toContain('Patch releases install themselves.')
})

test('off for a reason the switch cannot change shows the reason and no button', async () => {
  for (const reason of ['the update check is off', 'KINFOLD_NO_AUTO_UPDATE is set', 'no install record']) {
    const { block } = mount(await load(), { ...OFF, reason })
    expect(block.textContent).toContain(`Patch releases are not installed automatically: ${reason}.`)
    expect(button(block)).toBeUndefined()
  }
})

test('the last update and the last error are shown as text', async () => {
  const { block } = mount(await load(), {
    ...ON,
    lastUpdate: { version: '0.2.1', previous: '0.2.0', at: AT },
    lastError: { version: '0.2.2', at: AT, reason: 'the program download answered 503; nothing was changed' },
  })
  expect(block.textContent).toContain('Last update: 0.2.1 (was 0.2.0) on 2027-01-15.')
  expect(block.textContent).toContain('Last error: 0.2.2 on 2027-01-15: the program download answered 503; nothing was changed. It is tried again after the next daily check.')
  expect(elements(block).some((element) => element.className.includes('notice-error'))).toBe(true)
})

test('a failed save says so and leaves the state as it was', async () => {
  const { block } = mount(await load(), ON, async () => {
    throw new Error('this data folder has no install record; run kinfold install first')
  })
  fire(button(block)!, 'click')
  await flush()
  expect(block.textContent).toContain('this data folder has no install record; run kinfold install first')
  expect(button(block)?.textContent).toBe('Turn off')
})

test('a daemon that reports nothing about auto-update gets a plain line and no switch', async () => {
  const { block } = mount(await load(), null)
  expect(block.textContent).toContain('This daemon does not report its update settings.')
  expect(button(block)).toBeUndefined()
})

test('the block ships with the release build', () => {
  expect(EMBEDDED_ASSET_NAMES as readonly string[]).toContain('updates-block.js')
})

test('a blocker says it is tried again on a change, not daily', async () => {
  const { block } = mount(await load(), { ...ON, lastError: { version: '0.2.2', at: AT, reason: 'the daemon is not run by a background service here; run kinfold update', blocked: true } })
  expect(block.textContent).toContain('It is tried again when the daemon restarts or the install changes.')
  expect(block.textContent).not.toContain('next daily check')
})
