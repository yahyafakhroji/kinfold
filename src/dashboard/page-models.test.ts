import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type FakeElement, elements, fakeDocument, textNodes } from './fake-dom'
import { PUBLIC_DIR } from './routes'

// The model settings page in the fake DOM, which throws on innerHTML: the
// stopped class and the model names come from the daemon and must stay text.
const HOSTILE = '<img src=x onerror=alert(1)>'
const CODEX = { provider: 'codex-cli', model: 'gpt-x', credentialRef: null, enabled: true, source: 'host' }
const VIEW = {
  rows: [{ host: 'codex', ...CODEX }],
  safety: [{ provider: 'codex-cli', cliVersion: '1.0', status: 'failed', errorClass: HOSTILE, checkedAt: 1 }],
  effective: [{ host: 'codex', settings: CODEX }, { host: 'opencode', settings: { ...CODEX, provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter' } }],
}
const MODELS = { ok: true, models: ['gpt-a', HOSTILE] }

let saved: { document: unknown; fetch: unknown }
const calls: string[] = []
beforeAll(() => {
  const globals = globalThis as Record<string, unknown>
  saved = { document: globals.document, fetch: globals.fetch }
  globals.document = fakeDocument()
  globals.fetch = async (path: string, init: { method: string }) => {
    calls.push(`${init.method} ${path}`)
    const body = path.startsWith('/observer/models') ? MODELS : path === '/observer/recheck' ? { ok: true, cleared: 1 } : VIEW
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
})
afterAll(() => {
  const globals = globalThis as Record<string, unknown>
  globals.document = saved.document
  globals.fetch = saved.fetch
})

const load = async () => (await import(join(PUBLIC_DIR, 'page-models.js'))) as {
  renderModels(): Promise<FakeElement>
  stoppedClass(safety: unknown[], provider: string): string | null
}
const textOf = (root: FakeElement): string => textNodes(root).map((node) => node.textContent).join('|')

test('stoppedClass finds the failed row for a provider only', async () => {
  const { stoppedClass } = await load()
  expect(stoppedClass(VIEW.safety, 'codex-cli')).toBe(HOSTILE)
  expect(stoppedClass(VIEW.safety, 'opencode-cli')).toBeNull()
  expect(stoppedClass([{ provider: 'codex-cli', status: 'passed', errorClass: null }], 'codex-cli')).toBeNull()
})

test('a host on a stopped CLI shows "Stopped: <class>" as text, and Re-check posts the provider', async () => {
  const page = await (await load()).renderModels()
  const shown = textOf(page)
  expect(shown).toContain(`Stopped: ${HOSTILE}`)
  expect(shown.match(/Stopped:/g)).toHaveLength(1)
  const button = elements(page).find((element) => element.getAttribute('data-recheck') === '1')
  expect(button).toBeDefined()
  button!.listeners.get('click')![0]!({})
  await Bun.sleep(10)
  expect(calls).toContain('POST /observer/recheck')
  expect(textOf(page)).toContain('within a minute')
})

test('the model field is backed by a datalist filled from /observer/models, names as text', async () => {
  const page = await (await load()).renderModels()
  await Bun.sleep(10)
  expect(calls.filter((call) => call.startsWith('GET /observer/models?provider=codex-cli'))).not.toHaveLength(0)
  expect(calls.some((call) => call.includes('provider=openrouter'))).toBe(false)
  const list = elements(page).find((element) => element.tagName === 'DATALIST')
  expect(list).toBeDefined()
  const options = list!.childNodes.map((option) => (option as FakeElement).getAttribute('value'))
  expect(options).toEqual(['gpt-a', HOSTILE])
  const input = elements(page).find((element) => element.getAttribute('name') === 'model')
  expect(input?.getAttribute('list')).toBe(list!.getAttribute('id'))
})
