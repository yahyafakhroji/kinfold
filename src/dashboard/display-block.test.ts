// The "What you see" block on the data page: the recall line switch and the
// opt-in impact test switch. Text only, and each button sends one change.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type FakeElement, elements, fakeDocument } from './fake-dom'
import { PUBLIC_DIR } from './routes'

interface Display {
  showRecall: boolean
  holdout: boolean
  holdoutHosts: string[]
}
type Sent = { method: string; path: string; body: unknown }
interface BlockModule {
  displayOf(value: unknown): Display | null
  displayBlock(display: Display | null, deps: { send(method: string, path: string, body: unknown): Promise<unknown> }): FakeElement
}

const DEFAULTS: Display = { showRecall: true, holdout: false, holdoutHosts: ['claude-code'] }

let saved: unknown
beforeAll(() => {
  saved = (globalThis as Record<string, unknown>).document
  ;(globalThis as Record<string, unknown>).document = fakeDocument()
})
afterAll(() => {
  ;(globalThis as Record<string, unknown>).document = saved
})

const load = async (): Promise<BlockModule> => (await import(join(PUBLIC_DIR, 'display-block.js'))) as BlockModule
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const fire = (element: FakeElement): void => {
  for (const listener of element.listeners.get('click') ?? []) listener({ preventDefault: () => {} })
}
const button = (block: FakeElement, label: string): FakeElement | undefined =>
  elements(block).find((element) => element.tagName === 'BUTTON' && element.getAttribute('aria-label') === label)

function mount(page: BlockModule, display: Display | null, answer: (body: unknown) => Promise<unknown>) {
  const sent: Sent[] = []
  const block = page.displayBlock(display, { send: (method, path, body) => (sent.push({ method, path, body }), answer(body)) })
  return { block, sent }
}

test('by default the recall line is on, the impact test is off, and the block says what each does', async () => {
  const { block } = mount(await load(), DEFAULTS, async () => DEFAULTS)
  const shown = block.textContent
  expect(shown).toContain('What you see')
  expect(shown).toContain('say what Kinfold recalled after each prompt')
  expect(shown).toContain("never enter the model's context")
  expect(shown).toContain('Off. Every prompt gets its recalled memory.')
  expect(shown).toContain('Opt-in.')
  expect(shown).toContain('on claude-code only')
  expect(button(block, 'Turn off the recall line')).toBeDefined()
  expect(button(block, 'Turn on the impact test')).toBeDefined()
})

test('turning the impact test on sends that one change and shows the saved state, naming the agents and that it says so', async () => {
  const { block, sent } = mount(await load(), DEFAULTS, async () => ({ ...DEFAULTS, holdout: true }))
  fire(button(block, 'Turn on the impact test')!)
  await flush()
  expect(sent).toEqual([{ method: 'PUT', path: '/data/display', body: { holdout: true } }])
  expect(block.textContent).toContain('On for claude-code. About 1 prompt in 10 goes without recalled memory, and the agent says so each time.')
  expect(button(block, 'Turn off the impact test')).toBeDefined()
})

test('turning the recall line off sends that one change, and a failed save says why and keeps the state', async () => {
  const page = await load()
  const off = mount(page, DEFAULTS, async () => ({ ...DEFAULTS, showRecall: false }))
  fire(button(off.block, 'Turn off the recall line')!)
  await flush()
  expect(off.sent).toEqual([{ method: 'PUT', path: '/data/display', body: { showRecall: false } }])
  expect(off.block.textContent).toContain('Agents show nothing about what Kinfold recalled. Memory still reaches the model as before.')

  const failing = mount(page, DEFAULTS, async () => { throw new Error('the daemon did not answer; is it running?') })
  fire(button(failing.block, 'Turn off the recall line')!)
  await flush()
  expect(failing.block.textContent).toContain('the daemon did not answer; is it running?')
  expect(button(failing.block, 'Turn off the recall line')).toBeDefined()
})

test('a daemon that reports nothing gets no switches, and a malformed answer is not trusted', async () => {
  const page = await load()
  const { block } = mount(page, null, async () => null)
  expect(block.textContent).toContain('This daemon does not report these settings.')
  expect(elements(block).some((element) => element.tagName === 'BUTTON')).toBe(false)
  expect(page.displayOf({ showRecall: 'yes', holdout: false })).toBeNull()
  expect(page.displayOf(null)).toBeNull()
  expect(page.displayOf({ showRecall: true, holdout: true, holdoutHosts: ['claude-code', 7] })).toEqual({ showRecall: true, holdout: true, holdoutHosts: ['claude-code'] })
})
