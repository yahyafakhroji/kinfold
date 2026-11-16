import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type FakeElement, elements, fakeDocument } from './fake-dom'
import { EMBEDDED_ASSET_NAMES, PUBLIC_DIR } from './routes'

// The Embeddings block on the models page: which embedder makes the vectors,
// how far each space has come, and a button per provider. Text only.

interface Space { model: string; dims: number; indexed: number; pending: number; vecReady: boolean }
interface View {
  settings: { provider: string; llmUrl: string | null; llmModel: string | null; llmDims: number | null } | null
  active: Space | null
  building: Space | null
  lastError: string | null
}
type Sent = { method: string; path: string; body: unknown }
interface BlockModule {
  embeddingsBlock(view: View | null, deps: { send(method: string, path: string, body: unknown): Promise<unknown> }, hints?: { observerEndpoint?: string | null }): FakeElement
}

const LOCAL: View = {
  settings: { provider: 'local', llmUrl: null, llmModel: null, llmDims: null },
  active: { model: 'local/all-MiniLM-L6-v2', dims: 384, indexed: 90, pending: 10, vecReady: true },
  building: null,
  lastError: null,
}

let saved: unknown
beforeAll(() => {
  saved = (globalThis as Record<string, unknown>).document
  ;(globalThis as Record<string, unknown>).document = fakeDocument()
})
afterAll(() => {
  ;(globalThis as Record<string, unknown>).document = saved
})

const load = async (): Promise<BlockModule> => (await import(join(PUBLIC_DIR, 'embeddings-block.js'))) as BlockModule
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const fire = (element: FakeElement, type: string): void => {
  for (const listener of element.listeners.get(type) ?? []) listener({ preventDefault: () => {} })
}
const buttonNamed = (block: FakeElement, text: string): FakeElement | undefined =>
  elements(block).find((element) => element.tagName === 'BUTTON' && element.textContent === text)

function mount(page: BlockModule, view: View | null, answer: (body: unknown) => Promise<unknown> = async (body) => ({ saved: body, restarting: true })) {
  const sent: Sent[] = []
  const block = page.embeddingsBlock(view, { send: (method, path, body) => (sent.push({ method, path, body }), answer(body)) })
  return { block, sent }
}

test('the block is one of the embedded dashboard files', () => {
  expect(EMBEDDED_ASSET_NAMES).toContain('embeddings-block.js')
})

test('it names the current embedder and how much is indexed', async () => {
  const { block } = mount(await load(), LOCAL)
  expect(block.textContent).toContain('Local model, on this machine')
  expect(block.textContent).toContain('90 of 100 memories have vectors')
  expect(buttonNamed(block, 'Use local model')).toBeUndefined()
  expect(buttonNamed(block, 'Use OpenRouter')).toBeDefined()
})

test('a switch in progress says search stays on the old space until the new one is built', async () => {
  const view: View = { ...LOCAL, settings: { provider: 'openrouter', llmUrl: null, llmModel: null, llmDims: null }, building: { model: 'openai/text-embedding-3-small', dims: 512, indexed: 40, pending: 60, vecReady: false } }
  const { block } = mount(await load(), view)
  expect(block.textContent).toContain('Building openai/text-embedding-3-small: 40 of 100.')
  expect(block.textContent).toContain('Search uses local/all-MiniLM-L6-v2 until then.')
})

test('Use OpenRouter sends the choice and says the daemon is switching', async () => {
  const { block, sent } = mount(await load(), LOCAL)
  fire(buttonNamed(block, 'Use OpenRouter')!, 'click')
  await flush()
  expect(sent).toEqual([{ method: 'PUT', path: '/embedding/settings', body: { provider: 'openrouter' } }])
  expect(block.textContent).toContain('Saved. Kinfold re-indexes in the background')
})

test('a refused save shows the reason', async () => {
  const { block } = mount(await load(), LOCAL, async () => Promise.reject(new Error('the local LLM did not answer')))
  fire(buttonNamed(block, 'Use OpenRouter')!, 'click')
  await flush()
  expect(block.textContent).toContain('the local LLM did not answer')
})

test('a daemon without the route says so', async () => {
  const { block } = mount(await load(), null)
  expect(block.textContent).toContain('This daemon does not report its embedding settings.')
})

test('the last indexing error is shown', async () => {
  const { block } = mount(await load(), { ...LOCAL, lastError: 'http_error: openrouter answered 401' })
  expect(block.textContent).toContain('Last indexing error: http_error: openrouter answered 401')
})

test('the local LLM address starts on an OpenAI-compatible observer on this machine when none is saved', async () => {
  const { block } = mount(await load(), LOCAL, undefined)
  const remount = (await load()).embeddingsBlock(LOCAL, { send: async () => ({}) }, { observerEndpoint: 'http://127.0.0.1:1234/v1' })
  const urlOf = (element: FakeElement) => elements(element).find((e) => e.tagName === 'INPUT' && e.attributes.get('name') === 'llmUrl')?.attributes.get('value')
  expect(urlOf(block)).toBe('http://127.0.0.1:11434/v1')
  expect(urlOf(remount)).toBe('http://127.0.0.1:1234/v1')
})
