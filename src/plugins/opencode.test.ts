import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuildProjectPacks } from '../context/packs'
import { seedObservation } from '../context/test-support'
import type { ContextRequest, ContextResult } from '../context/types'
import { type RunningDaemon, startDaemon } from '../daemon/daemon'
import { openStore } from '../store/db'
import { upsertProject, upsertSession } from '../store/writes'
import * as entry from './opencode'
import { type ContextFetcher, type OpenCodeSetupContext, createOpenCodePlugin } from './opencode-plugin'

const FIXTURES = join(import.meta.dir, '../../test/fixtures/opencode')
const fixture = <T = unknown>(name: string): T =>
  (JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as { payload: T }).payload

type Handler = (event: unknown) => unknown

let root: string
let logs: string[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-opencode-'))
  logs = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

interface FakeHost {
  ctx: OpenCodeSetupContext
  handlers: Map<string, Handler>
}

function fakeHost(subscribeResult?: (listener: Handler) => unknown): FakeHost {
  const handlers = new Map<string, Handler>()
  const ctx: OpenCodeSetupContext = {
    location: fixture<{ location: { directory: string } }>('setup.context').location,
    tool: { hook: (name, handler) => handlers.set(`tool.${name}`, handler) },
    session: { hook: (name, handler) => handlers.set(`session.${name}`, handler) },
    event: {
      subscribe: (listener) => {
        handlers.set('bus', listener)
        return subscribeResult?.(listener)
      },
    },
  }
  return { ctx, handlers }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function spooledEvents(): { kind: string; hostPromptId?: string; assistantText?: string; tool?: { name: string } }[] {
  const dir = join(root, 'spool')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
}

test('the entry file exports only a default { id, setup }', () => {
  expect(Object.keys(entry)).toEqual(['default'])
  expect(Object.keys(entry.default).sort()).toEqual(['id', 'setup'])
  expect(typeof entry.default.setup).toBe('function')
})

test('tool, prompt and bus events reach the spool without changing the events OpenCode passed', async () => {
  const { ctx, handlers } = fakeHost()
  createOpenCodePlugin({ dataDir: () => root, log: (line) => logs.push(line), sessionOwners: new Map() }).setup(ctx)

  const inputs = [
    ['session.prompt', fixture('session.prompt')],
    ['tool.execute.after', fixture('tool.execute.after.shell')],
    ['bus', fixture('bus.session.created')],
    ['bus', fixture('bus.session.text.ended')],
    ['bus', fixture('bus.session.execution.succeeded')],
  ] as const
  for (const [name, input] of inputs) {
    const before = structuredClone(input)
    expect(handlers.get(name)!(input)).toBeUndefined()
    expect(input).toEqual(before)
  }
  await flush()

  const kinds = spooledEvents().map((event) => event.kind).sort()
  expect(kinds).toEqual(['session_start', 'tool_result', 'turn_end', 'user_prompt'])
  expect(spooledEvents().find((event) => event.kind === 'user_prompt')?.hostPromptId).toBe('msg_fixture0012')
  expect(logs.every((line) => line.includes('nudge skipped'))).toBe(true)
})

test('a session whose session.created was published before the instance subscribed still starts, once', async () => {
  const { ctx, handlers } = fakeHost()
  createOpenCodePlugin({ dataDir: () => root, log: (line) => logs.push(line), sessionOwners: new Map() }).setup(ctx)
  const text = fixture<{ created: number; location: { directory: string } }>('bus.session.text.ended')
  handlers.get('bus')!(text)
  handlers.get('bus')!(fixture('bus.session.execution.succeeded'))
  handlers.get('bus')!(fixture('bus.session.created'))
  await flush()

  const events = spooledEvents()
  expect(events.map((event) => event.kind).sort()).toEqual(['session_start', 'turn_end'])
  expect(events.find((event) => event.kind === 'session_start')).toMatchObject({ occurredAt: text.created })
})

test('instances for other directories ignore a shared bus envelope, so a session starts once', async () => {
  const hosts = [fakeHost(), fakeHost(), fakeHost()]
  const [own, ...others] = hosts
  // Separate plugin objects sharing one registry, as separate module copies share globalThis.
  const sessionOwners = new Map<string, string>()
  const plugin = (): ReturnType<typeof createOpenCodePlugin> => createOpenCodePlugin({ dataDir: () => root, log: (line) => logs.push(line), sessionOwners })
  plugin().setup(own!.ctx)
  others.forEach((host, i) => plugin().setup({ ...host.ctx, location: { directory: join(root, `other-${i}`) } }))

  // Real order: OpenCode hands each envelope to every instance, the owner's directory first or not.
  for (const name of ['bus.session.created', 'bus.session.text.ended', 'bus.session.execution.succeeded']) {
    for (const host of [...others, own!]) host.handlers.get('bus')!(fixture(name))
  }
  await flush()

  const events = spooledEvents()
  expect(events.map((event) => event.kind).sort()).toEqual(['session_start', 'turn_end'])
  expect(events.find((event) => event.kind === 'turn_end')?.assistantText).toBe(fixture<{ data: { text: string } }>('bus.session.text.ended').data.text)
})

test('a malformed event is logged and skipped, never thrown into OpenCode', () => {
  const { ctx, handlers } = fakeHost()
  createOpenCodePlugin({ dataDir: () => root, log: (line) => logs.push(line), sessionOwners: new Map() }).setup(ctx)

  expect(() => handlers.get('tool.execute.after')!({ nope: true })).not.toThrow()
  expect(logs).toHaveLength(1)
  expect(logs[0]).toStartWith('sam-opencode: event skipped:')
  expect(spooledEvents()).toEqual([])
})

test('a subscribe() that hands back a stream is consumed too', async () => {
  const envelopes = [fixture('bus.session.created')]
  const stream = (async function* () {
    yield* envelopes
  })()
  const { ctx } = fakeHost(() => stream)
  createOpenCodePlugin({ dataDir: () => root, log: (line) => logs.push(line), sessionOwners: new Map() }).setup(ctx)
  await flush()

  expect(spooledEvents().map((event) => event.kind)).toEqual(['session_start'])
})

test('under the observer (KINFOLD_OBSERVER=1) setup registers no hooks and nothing reaches the spool', async () => {
  const { ctx, handlers } = fakeHost()
  createOpenCodePlugin({ dataDir: () => root, log: (line) => logs.push(line), sessionOwners: new Map(), env: { KINFOLD_OBSERVER: '1' } }).setup(ctx)
  expect([...handlers.keys()]).toEqual([])
  await flush()
  expect(spooledEvents()).toEqual([])
  expect(logs).toEqual([])
})

// --- per-request context injection (task 8) ---

const PACK: ContextResult = { text: '<shared-agent-memory>\n[claude-code · 2h · tool-verified] A fact (#1)\n</shared-agent-memory>', observationIds: [1], tokens: 20 }

interface ContextEvent {
  sessionID: string
  system: { type: string; text?: string }[]
}

function contextEvent(sessionID = 'ses_fixture0011'): ContextEvent {
  return { ...fixture<ContextEvent>('session.context'), sessionID }
}

function countingFetcher(result: ContextResult | null | Error = PACK): { fetcher: ContextFetcher; requests: ContextRequest[] } {
  const requests: ContextRequest[] = []
  const fetcher: ContextFetcher = async (request) => {
    requests.push(request)
    if (result instanceof Error) throw result
    return result
  }
  return { fetcher, requests }
}

function setupWith(fetcher: ContextFetcher): Map<string, Handler> {
  const { ctx, handlers } = fakeHost()
  createOpenCodePlugin({ dataDir: () => root, log: (line) => logs.push(line), sessionOwners: new Map(), fetchContext: fetcher }).setup(ctx)
  return handlers
}

test('the context hook appends exactly one text part and leaves the existing parts untouched', async () => {
  const { fetcher, requests } = countingFetcher()
  const handlers = setupWith(fetcher)
  const event = contextEvent()
  const before = structuredClone(event.system)

  await handlers.get('session.context')!(event)
  expect(event.system).toHaveLength(before.length + 1)
  expect(event.system.slice(0, before.length)).toEqual(before)
  expect(event.system.at(-1)).toEqual({ type: 'text', text: PACK.text })
  expect(requests).toEqual([{ host: 'opencode', cwd: '/Users/dev/Dev/rea/shared-agent-memory', hostSessionId: 'ses_fixture0011', channel: 'request' }])
})

test('the pack is fetched once per session and cached across requests', async () => {
  const { fetcher, requests } = countingFetcher()
  const handlers = setupWith(fetcher)
  const events = [contextEvent(), contextEvent(), contextEvent('ses_other')]
  await Promise.all(events.map((event) => handlers.get('session.context')!(event)))
  await handlers.get('session.context')!(contextEvent())

  expect(requests.map((request) => request.hostSessionId)).toEqual(['ses_fixture0011', 'ses_other'])
  for (const event of events) expect(event.system.filter((part) => part.text === PACK.text)).toHaveLength(1)
})

test('a reused system list never gets the pack twice', async () => {
  const handlers = setupWith(countingFetcher().fetcher)
  const event = contextEvent()
  await handlers.get('session.context')!(event)
  await handlers.get('session.context')!(event)
  expect(event.system.filter((part) => part.text === PACK.text)).toHaveLength(1)
})

test('compaction drops the session cache, so the next request fetches again', async () => {
  const { fetcher, requests } = countingFetcher()
  const handlers = setupWith(fetcher)
  await handlers.get('session.context')!(contextEvent())
  await handlers.get('session.compaction')!({ sessionID: 'ses_fixture0011' })
  await handlers.get('session.context')!(contextEvent())
  expect(requests).toHaveLength(2)
  expect(logs).toContain('sam-opencode: context cache dropped session=ses_fixture0011 (compaction)')
})

test('an empty pack, a failed fetch or a malformed event adds nothing and never throws', async () => {
  for (const result of [{ text: '', observationIds: [], tokens: 0 }, null, new Error('boom')]) {
    const handlers = setupWith(countingFetcher(result).fetcher)
    const event = contextEvent()
    const before = structuredClone(event.system)
    await handlers.get('session.context')!(event)
    expect(event.system).toEqual(before)
    await handlers.get('session.context')!({ nope: true })
    await handlers.get('session.context')!({ sessionID: 'x', system: 'not a list' })
  }
  expect(logs).toContain('sam-opencode: context session=ses_fixture0011 failed: Error')
  expect(logs.join('\n')).not.toContain('shared-agent-memory>')
})

test('end to end with a daemon: the stored pack lands in the request and the injection is recorded as request', async () => {
  const dataDir = join(root, 'data')
  const store = openStore(dataDir)
  try {
    upsertProject(store.db, { key: root, kind: 'path', displayName: 'plugin-repo' }, Date.now())
    const session = upsertSession(store.db, { host: 'claude-code', hostSessionId: 'cc', projectKey: root, cwd: root, occurredAt: Date.now() })
    seedObservation(store, { sessionId: session, projectKey: root, host: 'claude-code', title: 'Plugin reads the shared pack', at: Date.now() })
    rebuildProjectPacks(store.db, root, Date.now())
  } finally {
    store.db.close()
  }
  const daemon: RunningDaemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  try {
    const { ctx, handlers } = fakeHost()
    createOpenCodePlugin({ dataDir: () => dataDir, log: (line) => logs.push(line), sessionOwners: new Map() }).setup({ ...ctx, location: { directory: root } })
    const event = contextEvent('ses_live')
    await handlers.get('session.context')!(event)
    expect(event.system.at(-1)!.text).toContain('[claude-code · 1m · tool-verified] Plugin reads the shared pack (#1)')

    const reader = openStore(dataDir)
    try {
      expect(reader.db.query('SELECT host, host_session_id, channel FROM injections').all()).toEqual([
        { host: 'opencode', host_session_id: 'ses_live', channel: 'request' },
      ])
    } finally {
      reader.db.close()
    }
  } finally {
    await daemon.stop()
  }
})

test('a prompt is spooled and its text rides on the next delta ask, never in a log line', async () => {
  const { fetcher, requests } = countingFetcher()
  const handlers = setupWith(fetcher)
  const prompt = fixture<{ prompt: { text: string } }>('session.prompt')
  await handlers.get('session.context')!(contextEvent())
  handlers.get('session.prompt')!(prompt)
  await handlers.get('session.context')!(contextEvent())
  await flush()

  expect(requests.map((request) => request.channel)).toEqual(['request', 'prompt'])
  expect(requests[1]!.prompt).toBe(prompt.prompt.text)
  expect(spooledEvents().map((event) => event.kind)).toContain('user_prompt')
  expect(logs.some((line) => line.includes(prompt.prompt.text))).toBe(false)
})
