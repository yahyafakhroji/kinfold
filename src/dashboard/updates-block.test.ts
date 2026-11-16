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
interface Settings { level: 'off' | 'notify' | 'patch'; beta: boolean }
interface BlockModule {
  updatesBlock(auto: Auto | null, settings: Settings | null, deps: { send(method: string, path: string, body?: unknown): Promise<unknown> }): FakeElement
}
const PATCH: Settings = { level: 'patch', beta: false }

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
const buttons = (block: FakeElement): FakeElement[] => elements(block).filter((element) => element.tagName === 'BUTTON')
const button = (block: FakeElement, label?: string): FakeElement | undefined => buttons(block).find((element) => label === undefined || element.textContent === label)

function mount(page: BlockModule, auto: Auto | null, settings: Settings | null = PATCH, answer: (method: string, path: string, body: unknown) => Promise<unknown> = async (_m, path) => (path === '/update/auto' ? { auto: OFF } : { settings: { level: 'notify', beta: false } })) {
  const sent: Sent[] = []
  const block = page.updatesBlock(auto, settings, { send: (method, path, body) => (sent.push({ method, path, body }), answer(method, path, body)) })
  return { block, sent }
}

test('on: the block says so and marks patch as the chosen level', async () => {
  const { block } = mount(await load(), ON)
  expect(block.textContent).toContain('Patch releases install themselves.')
  expect(buttons(block).map((element) => element.textContent)).toEqual(['Off', 'Tell me', 'Patch and offer larger releases', 'Offer beta releases'])
  expect(button(block, 'Patch and offer larger releases')?.getAttribute('aria-pressed')).toBe('true')
  expect(button(block, 'Off')?.getAttribute('aria-pressed')).toBe('false')
})

test('choosing a level saves it with the beta choice, then shows what the daemon reports', async () => {
  const { block, sent } = mount(await load(), ON)
  fire(button(block, 'Tell me')!, 'click')
  await flush()
  await flush()
  expect(sent).toEqual([{ method: 'PUT', path: '/update/settings', body: { level: 'notify', beta: false } }, { method: 'GET', path: '/update/auto', body: undefined }])
  expect(block.textContent).toContain('Patch releases are not installed automatically.')
  expect(button(block, 'Tell me')?.getAttribute('aria-pressed')).toBe('true')
})

test('the beta button turns betas on and off, keeping the level', async () => {
  const { block, sent } = mount(await load(), ON, PATCH, async (_m, path) => (path === '/update/auto' ? { auto: ON } : { settings: { level: 'patch', beta: true } }))
  fire(button(block, 'Offer beta releases')!, 'click')
  await flush()
  await flush()
  expect(sent[0]).toEqual({ method: 'PUT', path: '/update/settings', body: { level: 'patch', beta: true } })
  expect(button(block, 'Stop offering beta releases')).toBeDefined()
})

test('off for a reason the settings cannot change shows the reason', async () => {
  for (const reason of ['the update check is off', 'KINFOLD_NO_AUTO_UPDATE is set']) {
    const { block } = mount(await load(), { ...OFF, reason })
    expect(block.textContent).toContain(`Patch releases are not installed automatically: ${reason}.`)
  }
  const { block } = mount(await load(), { ...OFF, reason: 'no install record' }, null)
  expect(button(block)).toBeUndefined()
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
  const { block } = mount(await load(), ON, PATCH, async () => {
    throw new Error('this data folder has no install record; run kinfold install first')
  })
  fire(button(block, 'Off')!, 'click')
  await flush()
  expect(block.textContent).toContain('this data folder has no install record; run kinfold install first')
  expect(button(block, 'Patch and offer larger releases')?.getAttribute('aria-pressed')).toBe('true')
})

test('a daemon that reports nothing about auto-update gets a plain line and no switch', async () => {
  const { block } = mount(await load(), null, null)
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
