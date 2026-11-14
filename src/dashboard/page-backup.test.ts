import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type FakeElement, elements, fakeDocument, textNodes } from './fake-dom'
import { PUBLIC_DIR } from './routes'

// The backup page in the fake DOM, which throws on innerHTML. What the
// manifest says comes from an uploaded file, so it must stay text; the
// recovery code must reach one request body and nothing else.
const HOSTILE = '<img src=x onerror=alert(1)>'
const CODE = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH-JKMNP-QRSTV-WXYZ0'
const MANIFEST = { createdAt: Date.UTC(2026, 10, 14, 9, 30), kinfoldVersion: '0.2.0', schemaVersion: 11, encrypted: true, bytes: 5 * 1024 * 1024 }
const UPLOAD = 'a'.repeat(32)

interface Flow {
  stage: string
}
interface FlowModule {
  idleRestore(): Flow
  uploadedRestore(answer: unknown): Flow
  canRestore(flow: Flow, code: string, confirmed: boolean): boolean
  restoreBody(flow: Flow, code: string, confirmed: boolean): Record<string, string>
  describeManifest(manifest: typeof MANIFEST): [string, string][]
  stepText(step: string | null): string
}
interface Deps {
  send(method: string, path: string, body?: unknown): Promise<unknown>
  upload(path: string, file: unknown): Promise<unknown>
  wait(ms: number): Promise<void>
}
interface PageModule {
  renderBackup(state: unknown, ctx: unknown, deps?: Deps): Promise<FakeElement>
}
interface ApiModule {
  uploadFile(path: string, file: unknown): Promise<unknown>
}

let saved: { document: unknown; fetch: unknown }
beforeAll(() => {
  const globals = globalThis as Record<string, unknown>
  saved = { document: globals.document, fetch: globals.fetch }
  globals.document = fakeDocument()
})
afterAll(() => {
  const globals = globalThis as Record<string, unknown>
  globals.document = saved.document
  globals.fetch = saved.fetch
})

const load = async <T>(name: string): Promise<T> => (await import(join(PUBLIC_DIR, name))) as T
const textOf = (root: FakeElement): string => textNodes(root).map((node) => node.textContent).join('|')
const named = (root: FakeElement, name: string): FakeElement => {
  const found = elements(root).find((element) => element.getAttribute('name') === name || element.getAttribute('data-action') === name)
  if (found === undefined) throw new Error(`no element ${name}`)
  return found
}
const fire = (element: FakeElement, type: string): void => {
  for (const listener of element.listeners.get(type) ?? []) listener({ preventDefault: () => {} })
}
const settle = (): Promise<void> => Bun.sleep(5)

interface Recorded {
  calls: [string, string, unknown][]
  uploads: [string, unknown][]
  deps: Deps
}

/** Fake daemon answers: the upload, the restore start, then each status in turn (the last one repeats). */
function daemon(options: { manifest?: Record<string, unknown>; start?: () => unknown; statuses?: unknown[] } = {}): Recorded {
  const calls: Recorded['calls'] = []
  const uploads: Recorded['uploads'] = []
  const statuses = [...(options.statuses ?? [{ state: 'running', step: 'swap', lines: [], error: null }, { state: 'done', step: null, lines: ['restored the backup made 2026-11-14', HOSTILE], error: null }])]
  const deps: Deps = {
    send: async (method, path, body) => {
      calls.push([method, path, body])
      if (path === '/restore') return (options.start ?? (() => ({ started: true })))()
      if (path === '/restore/status') return statuses.length > 1 ? statuses.shift() : statuses[0]
      throw new Error(`unexpected ${method} ${path}`)
    },
    upload: async (path, file) => {
      uploads.push([path, file])
      return { upload: UPLOAD, manifest: options.manifest ?? MANIFEST }
    },
    wait: async () => {},
  }
  return { calls, uploads, deps }
}

async function uploadedPage(recorded: Recorded): Promise<FakeElement> {
  const page = await (await load<PageModule>('page-backup.js')).renderBackup({ page: 'backup', params: {} }, {}, recorded.deps)
  const file = named(page, 'file') as FakeElement & { files?: unknown[] }
  file.files = [{ name: 'memory.kfb', size: 10 }]
  fire(file, 'change')
  fire(named(page, 'upload'), 'click')
  await settle()
  return page
}

function type(page: FakeElement, code: string, confirmed: boolean): void {
  const input = named(page, 'code') as FakeElement & { value?: string }
  const confirm = named(page, 'confirm') as FakeElement & { checked?: boolean }
  input.value = code
  confirm.checked = confirmed
  fire(input, 'input')
  fire(confirm, 'change')
}

test('the flow allows a restore only after an upload, a confirmation and, for an encrypted backup, a code', async () => {
  const flow = await load<FlowModule>('restore-flow.js')
  const idle = flow.idleRestore()
  expect(flow.canRestore(idle, CODE, true)).toBe(false)
  expect(() => flow.restoreBody(idle, CODE, true)).toThrow()
  const uploaded = flow.uploadedRestore({ upload: UPLOAD, manifest: MANIFEST })
  expect(flow.canRestore(uploaded, '', true)).toBe(false)
  expect(flow.canRestore(uploaded, '   ', true)).toBe(false)
  expect(flow.canRestore(uploaded, CODE, false)).toBe(false)
  expect(flow.canRestore(uploaded, CODE, true)).toBe(true)
  expect(flow.restoreBody(uploaded, ` ${CODE} `, true)).toEqual({ upload: UPLOAD, code: CODE })
  expect(() => flow.restoreBody(uploaded, CODE, false)).toThrow()
  const plain = flow.uploadedRestore({ upload: UPLOAD, manifest: { ...MANIFEST, encrypted: false } })
  expect(flow.canRestore(plain, '', true)).toBe(true)
  expect(flow.restoreBody(plain, 'ignored', true)).toEqual({ upload: UPLOAD })
  for (const answer of [null, {}, { upload: 5, manifest: MANIFEST }, { upload: UPLOAD }, { upload: UPLOAD, manifest: { ...MANIFEST, bytes: 'big' } }]) {
    expect(() => flow.uploadedRestore(answer)).toThrow()
  }
})

test('the manifest is described by date, version, size and whether it is encrypted', async () => {
  const flow = await load<FlowModule>('restore-flow.js')
  expect(flow.describeManifest(MANIFEST)).toEqual([
    ['Made', '2026-11-14 09:30'],
    ['Kinfold', '0.2.0'],
    ['Size', '5.0 MB'],
    ['Schema', '11'],
    ['Encrypted', 'yes, it needs its recovery code'],
  ])
  expect(flow.describeManifest({ ...MANIFEST, encrypted: false }).at(-1)).toEqual(['Encrypted', 'no, anyone who has the file can read it'])
  expect(flow.stepText('close')).toContain('agent sessions')
  expect(flow.stepText(null)).not.toBe('')
})

test('the page offers the download as a plain link and starts with Restore disabled', async () => {
  const page = await (await load<PageModule>('page-backup.js')).renderBackup({ page: 'backup', params: {} }, {}, daemon().deps)
  const link = elements(page).find((element) => element.getAttribute('href') === '/backup')
  expect(link).toBeDefined()
  expect(link!.getAttribute('download')).not.toBeNull()
  expect(named(page, 'restore').getAttribute('disabled')).not.toBeNull()
  expect(named(page, 'upload').getAttribute('disabled')).not.toBeNull()
  const code = named(page, 'code')
  expect(code.getAttribute('type')).toBe('password')
  expect(code.getAttribute('autocomplete')).toBe('off')
  expect(textOf(page)).toContain('recovery code')
})

test('an upload shows what the manifest says, as text', async () => {
  const recorded = daemon({ manifest: { ...MANIFEST, kinfoldVersion: HOSTILE } })
  const page = await uploadedPage(recorded)
  expect(recorded.uploads).toEqual([['/restore/upload', { name: 'memory.kfb', size: 10 }]])
  const shown = textOf(page)
  expect(shown).toContain('2026-11-14 09:30')
  expect(shown).toContain(HOSTILE)
  expect(shown).toContain('5.0 MB')
  expect(named(page, 'restore').getAttribute('disabled')).not.toBeNull()
})

test('Restore sends the upload and the code in one body, clears the field, and shows the result as text', async () => {
  const recorded = daemon()
  const page = await uploadedPage(recorded)
  type(page, CODE, false)
  expect(named(page, 'restore').getAttribute('disabled')).not.toBeNull()
  type(page, CODE, true)
  expect(named(page, 'restore').getAttribute('disabled')).toBeNull()
  fire(named(page, 'restore'), 'click')
  // Cleared before the request even answers.
  expect((named(page, 'code') as FakeElement & { value?: string }).value).toBe('')
  await settle()
  expect(recorded.calls[0]).toEqual(['POST', '/restore', { upload: UPLOAD, code: CODE }])
  expect(recorded.calls.filter(([, path]) => path === '/restore')).toHaveLength(1)
  expect(recorded.calls.filter(([, path]) => path === '/restore/status').length).toBeGreaterThanOrEqual(2)
  const shown = textOf(page)
  expect(shown).toContain('restored the backup made 2026-11-14')
  expect(shown).toContain(HOSTILE)
  // The code is in no text node, no attribute and no request but the one.
  expect(shown).not.toContain(CODE)
  for (const element of elements(page)) for (const value of element.attributes.values()) expect(value).not.toContain(CODE)
  expect(JSON.stringify(recorded.calls.slice(1))).not.toContain(CODE)
  expect(recorded.calls.every(([, path]) => !path.includes(CODE) && !path.includes('?'))).toBe(true)
})

test('a refused code shows the daemon\'s reason and leaves the upload ready for another try', async () => {
  let tries = 0
  const recorded = daemon({
    start: () => {
      tries += 1
      if (tries === 1) throw new Error('that recovery code does not open this backup. Nothing was changed')
      return { started: true }
    },
  })
  const page = await uploadedPage(recorded)
  type(page, CODE, true)
  fire(named(page, 'restore'), 'click')
  await settle()
  expect(textOf(page)).toContain('does not open this backup')
  expect(textOf(page)).not.toContain(CODE)
  expect((named(page, 'code') as FakeElement & { value?: string }).value).toBe('')
  expect(named(page, 'restore').getAttribute('disabled')).not.toBeNull()
  type(page, CODE, true)
  expect(named(page, 'restore').getAttribute('disabled')).toBeNull()
  fire(named(page, 'restore'), 'click')
  await settle()
  expect(textOf(page)).toContain('restored the backup')
})

test('an unencrypted backup asks for no code and says the file is readable', async () => {
  const recorded = daemon({ manifest: { ...MANIFEST, encrypted: false } })
  const page = await uploadedPage(recorded)
  expect(named(page, 'code-field').getAttribute('hidden')).not.toBeNull()
  expect(textOf(page)).toContain('anyone who has the file can read it')
  type(page, '', true)
  fire(named(page, 'restore'), 'click')
  await settle()
  expect(recorded.calls[0]).toEqual(['POST', '/restore', { upload: UPLOAD }])
})

test('a restore that fails shows why', async () => {
  const recorded = daemon({ statuses: [{ state: 'failed', step: null, lines: [], error: 'another process is using memory.db' }] })
  const page = await uploadedPage(recorded)
  type(page, CODE, true)
  fire(named(page, 'restore'), 'click')
  await settle()
  expect(textOf(page)).toContain('another process is using memory.db')
})

test('uploadFile posts the file itself with our header and never as JSON', async () => {
  const seen: { path: string; init: RequestInit }[] = []
  ;(globalThis as Record<string, unknown>).fetch = async (path: string, init: RequestInit) => {
    seen.push({ path, init })
    return new Response(JSON.stringify({ upload: UPLOAD, manifest: MANIFEST }), { status: 200 })
  }
  const file = { name: 'memory.kfb' }
  const answer = await (await load<ApiModule>('api.js')).uploadFile('/restore/upload', file)
  expect(answer).toEqual({ upload: UPLOAD, manifest: MANIFEST })
  expect(seen).toHaveLength(1)
  expect(seen[0]!.path).toBe('/restore/upload')
  expect(seen[0]!.init.method).toBe('POST')
  expect(seen[0]!.init.body as unknown).toBe(file)
  expect(seen[0]!.init.headers).toEqual({ 'x-sam-request': '1', 'content-type': 'application/octet-stream' })
  ;(globalThis as Record<string, unknown>).fetch = async () => new Response(JSON.stringify({ error: 'this file is not a Kinfold backup' }), { status: 400 })
  await expect((await load<ApiModule>('api.js')).uploadFile('/restore/upload', file)).rejects.toThrow('not a Kinfold backup')
})
