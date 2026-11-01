import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type FakeElement, elements, fakeDocument } from './fake-dom'
import { PUBLIC_DIR } from './routes'

// The retention block on the data page: Preview first, Save disabled until a
// preview matches the form, any edit disables it again. Text only.

type Body = { retention: Record<string, number | null>; warnBytes: number }
type Sent = { method: string; path: string; body: Record<string, unknown> }
interface Deps { send(method: string, path: string, body: unknown): Promise<unknown>; read(form: unknown): Body }
interface PageModule { retentionBlock(settings: Body, deps: Deps): FakeElement }
interface FlowModule {
  idleRetention(): { stage: string }
  previewedRetention(body: Body, answer: unknown): { stage: string }
  canSave(flow: { stage: string }, body: Body): boolean
  saveBody(flow: { stage: string }, body: Body): Body
  retentionKey(body: Body): string
  describePreview(preview: unknown, tables: string[]): string
}

const load = async <T>(name: string): Promise<T> => (await import(join(PUBLIC_DIR, name))) as T
const TABLES = ['events', 'prompts', 'observations', 'summaries']
const SETTINGS: Body = { retention: { events: 30, prompts: null, observations: null, summaries: null }, warnBytes: 256 * 1024 * 1024 }
const PREVIEW = { settings: SETTINGS, tables: { events: { rows: 3, bytes: 2048 }, prompts: { rows: 0, bytes: 0 }, observations: { rows: 1, bytes: 10 }, summaries: { rows: 0, bytes: 0 } } }
const APPLIED = { saved: SETTINGS, applied: { events: 3, prompts: 0, observations: 1, summaries: 0 } }

let saved: unknown
beforeAll(() => {
  saved = (globalThis as Record<string, unknown>).document
  ;(globalThis as Record<string, unknown>).document = fakeDocument()
})
afterAll(() => {
  ;(globalThis as Record<string, unknown>).document = saved
})

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const fire = (element: FakeElement, type: string): void => {
  for (const listener of element.listeners.get(type) ?? []) listener({ preventDefault: () => {} })
}

function mount(page: PageModule) {
  let values: Body = structuredClone(SETTINGS)
  const sent: Sent[] = []
  const send = (method: string, path: string, body: unknown): Promise<unknown> => {
    sent.push({ method, path, body: body as Record<string, unknown> })
    return Promise.resolve((body as Record<string, unknown>).preview === true ? { preview: PREVIEW } : APPLIED)
  }
  const block = page.retentionBlock(SETTINGS, { send, read: () => structuredClone(values) })
  const all = elements(block)
  const form = all.find((element) => element.tagName === 'FORM')!
  const save = all.find((element) => element.tagName === 'BUTTON' && element.textContent === 'Save retention')!
  return {
    block, form, save, sent,
    set: (change: Partial<Body['retention']>) => { values = { ...values, retention: { ...values.retention, ...change } as Body['retention'] } },
    disabled: () => save.getAttribute('disabled') !== null,
  }
}

test('Save starts disabled, Preview sends preview: true and shows counts, then Save is enabled and sends no preview', async () => {
  const page = await load<PageModule>('page-data.js')
  const ui = mount(page)
  expect(ui.disabled()).toBe(true)
  fire(ui.save, 'click')
  expect(ui.sent).toEqual([])

  fire(ui.form, 'submit')
  await flush()
  expect(ui.sent[0]).toEqual({ method: 'PUT', path: '/data/retention', body: { ...SETTINGS, preview: true } })
  expect(ui.block.textContent).toContain('Preview, nothing saved. Saving now would expire: events 3 (2.0 KB), prompts 0 (0 B), observations 1 (10 B), summaries 0 (0 B).')
  expect(ui.disabled()).toBe(false)

  fire(ui.save, 'click')
  await flush()
  expect(ui.sent[1]).toEqual({ method: 'PUT', path: '/data/retention', body: SETTINGS })
  expect(ui.block.textContent).toContain('Saved. Applied now: events 3, prompts 0, observations 1, summaries 0.')
  expect(ui.disabled()).toBe(true)
})

test('editing a value after the preview disables Save until the new values are previewed', async () => {
  const ui = mount(await load<PageModule>('page-data.js'))
  fire(ui.form, 'submit')
  await flush()
  expect(ui.disabled()).toBe(false)

  ui.set({ prompts: 7 })
  fire(ui.form, 'input')
  expect(ui.disabled()).toBe(true)
  expect(ui.block.textContent).toContain('The values changed; preview again before saving.')
  fire(ui.save, 'click')
  expect(ui.sent).toHaveLength(1)

  fire(ui.form, 'submit')
  await flush()
  expect(ui.sent[1]!.body).toMatchObject({ retention: { prompts: 7 }, preview: true })
  expect(ui.disabled()).toBe(false)
  ui.set({ prompts: null })
  fire(ui.form, 'input')
  expect(ui.disabled()).toBe(true)
})

test('the flow: key ignores order, refuses a save without a matching preview, and needs a preview answer', async () => {
  const flow = await load<FlowModule>('retention-flow.js')
  const a: Body = { retention: { events: 1, prompts: null }, warnBytes: 5 }
  const b: Body = { retention: { prompts: null, events: 1 }, warnBytes: 5 }
  expect(flow.retentionKey(a)).toBe(flow.retentionKey(b))
  expect(flow.canSave(flow.idleRetention(), a)).toBe(false)
  expect(() => flow.saveBody(flow.idleRetention(), a)).toThrow('preview these values first')
  expect(() => flow.previewedRetention(a, { saved: a })).toThrow('a retention preview needs a preview answer')
  const previewed = flow.previewedRetention(a, { preview: PREVIEW })
  expect(flow.canSave(previewed, b)).toBe(true)
  expect(flow.canSave(previewed, { ...a, warnBytes: 6 })).toBe(false)
  expect(flow.saveBody(previewed, b)).toEqual(a)
  expect(flow.describePreview({ tables: {} }, TABLES)).toBe('nothing')
})
