import { expect, test } from 'bun:test'
import { type ContextRequest, type ContextResult, MAX_CONTEXT_PROMPT_CHARS } from '../context/types'
import { DELTA_INTERVAL_MS, MAX_DELTAS_PER_SESSION, PACK_RETRY_INTERVAL_MS, createContextInjector } from './context-injector'

const PACK: ContextResult = { text: '<kinfold>pack</kinfold>', observationIds: [1], tokens: 10 }
const delta = (n: number): ContextResult => ({ text: `<kinfold>delta ${n}</kinfold>`, observationIds: [100 + n], tokens: 8 })

interface Rig {
  requests: ContextRequest[]
  clock: { now: number }
  injector: ReturnType<typeof createContextInjector>
  context: (session?: string) => Promise<{ type: string; text?: string }[]>
}

/** A fake fetcher: the pack for `request`, the next queued delta (or an empty one) for `prompt`. */
function rig(deltas: (ContextResult | Error)[] = []): Rig {
  const requests: ContextRequest[] = []
  const clock = { now: 1_000_000 }
  const queue = [...deltas]
  const injector = createContextInjector({
    host: 'opencode', cwd: '/work/repo', log: () => {}, now: () => clock.now,
    fetch: async (request) => {
      requests.push(request)
      if (request.channel === 'request') return PACK
      const next = queue.shift()
      if (next instanceof Error) throw next
      return next ?? { text: '', observationIds: [], tokens: 0 }
    },
  })
  const context = async (session = 's1') => {
    const system: { type: string; text?: string }[] = [{ type: 'text', text: 'host system prompt' }]
    await injector.onContext({ sessionID: session, system })
    return system
  }
  return { requests, clock, injector, context }
}

const channels = (r: Rig): string[] => r.requests.map((request) => request.channel)

test('a pack missed while the daemon is down is retried after 30 s, not on every request', async () => {
  const requests: ContextRequest[] = []
  const clock = { now: 1_000_000 }
  let up = false
  const injector = createContextInjector({
    host: 'opencode', cwd: '/work/repo', log: () => {}, now: () => clock.now,
    fetch: async (request) => {
      requests.push(request)
      if (request.channel === 'prompt') return { text: '', observationIds: [], tokens: 0 }
      return up ? PACK : null
    },
  })
  const texts = async (): Promise<(string | undefined)[]> => {
    const system: { type: string; text?: string }[] = []
    await injector.onContext({ sessionID: 's1', system })
    return system.map((part) => part.text)
  }
  const packAsks = (): number => requests.filter((request) => request.channel === 'request').length

  expect(await texts()).toEqual([])
  up = true
  clock.now += PACK_RETRY_INTERVAL_MS - 1
  expect(await texts()).toEqual([])
  expect(packAsks()).toBe(1)

  clock.now += 1
  expect(await texts()).toEqual([PACK.text])
  expect(packAsks()).toBe(2)

  // A cached pack is never asked for again, however long the session lasts.
  clock.now += PACK_RETRY_INTERVAL_MS * 2
  expect(await texts()).toEqual([PACK.text])
  expect(packAsks()).toBe(2)
})

test('no delta is asked for within 30 s of the pack, then at most one per 30 s per session', async () => {
  const r = rig([delta(1), delta(2)])
  expect((await r.context()).map((part) => part.text)).toEqual(['host system prompt', PACK.text])
  r.clock.now += DELTA_INTERVAL_MS - 1
  await r.context()
  await r.context()
  expect(channels(r)).toEqual(['request'])

  r.clock.now += 1
  expect((await r.context()).map((part) => part.text)).toEqual(['host system prompt', PACK.text, delta(1).text])
  // Every later request carries the cached delta after the pack, without asking again.
  r.clock.now += 1_000
  expect((await r.context()).map((part) => part.text)).toEqual(['host system prompt', PACK.text, delta(1).text])
  expect(channels(r)).toEqual(['request', 'prompt'])

  r.clock.now += DELTA_INTERVAL_MS
  expect((await r.context()).map((part) => part.text)).toEqual(['host system prompt', PACK.text, delta(1).text, delta(2).text])
  expect(channels(r)).toEqual(['request', 'prompt', 'prompt'])
  expect(r.requests.every((request) => request.hostSessionId === 's1' && request.host === 'opencode')).toBe(true)
})

test('concurrent requests in one window share a single delta fetch, and sessions are limited separately', async () => {
  const r = rig([delta(1), delta(2)])
  await r.context('s1')
  await r.context('s2')
  r.clock.now += DELTA_INTERVAL_MS
  await Promise.all([r.context('s1'), r.context('s1'), r.context('s1')])
  expect(r.requests.filter((request) => request.channel === 'prompt' && request.hostSessionId === 's1')).toHaveLength(1)
  await r.context('s2')
  expect(r.requests.filter((request) => request.channel === 'prompt' && request.hostSessionId === 's2')).toHaveLength(1)
})

test('an empty or failed delta appends nothing; a reused system list never holds a text twice', async () => {
  const r = rig([{ text: '', observationIds: [], tokens: 0 }, new Error('down'), delta(3)])
  await r.context()
  for (let round = 0; round < 2; round += 1) {
    r.clock.now += DELTA_INTERVAL_MS
    expect((await r.context()).map((part) => part.text)).toEqual(['host system prompt', PACK.text])
  }
  r.clock.now += DELTA_INTERVAL_MS
  const system = await r.context()
  await r.injector.onContext({ sessionID: 's1', system })
  expect(system.map((part) => part.text)).toEqual(['host system prompt', PACK.text, delta(3).text])
})

test('deltas per session are capped (oldest goes) and compaction drops them with the pack', async () => {
  const r = rig(Array.from({ length: MAX_DELTAS_PER_SESSION + 2 }, (_, index) => delta(index)))
  await r.context()
  for (let round = 0; round < MAX_DELTAS_PER_SESSION + 2; round += 1) {
    r.clock.now += DELTA_INTERVAL_MS
    await r.context()
  }
  const texts = (await r.context()).map((part) => part.text)
  expect(texts).toHaveLength(2 + MAX_DELTAS_PER_SESSION)
  expect(texts).not.toContain(delta(0).text)
  expect(texts.at(-1)).toBe(delta(MAX_DELTAS_PER_SESSION + 1).text)

  r.injector.onCompaction({ sessionID: 's1' })
  expect((await r.context()).map((part) => part.text)).toEqual(['host system prompt', PACK.text])
  expect(channels(r).filter((channel) => channel === 'request')).toHaveLength(2)
})

test('a new prompt asks for the delta at once, carries its text once, and is cut to the cap', async () => {
  const r = rig([delta(1), delta(2)])
  await r.context()
  r.injector.onPrompt({ sessionID: 's1', prompt: { text: `fix the parser ${'x'.repeat(MAX_CONTEXT_PROMPT_CHARS)}` } })
  expect((await r.context()).map((part) => part.text)).toEqual(['host system prompt', PACK.text, delta(1).text])
  await r.context()
  expect(channels(r)).toEqual(['request', 'prompt'])
  expect(r.requests[1]!.prompt).toBe(`fix the parser ${'x'.repeat(MAX_CONTEXT_PROMPT_CHARS)}`.slice(0, MAX_CONTEXT_PROMPT_CHARS))

  // A promptless ask after the interval sends no text.
  r.clock.now += DELTA_INTERVAL_MS
  await r.context()
  expect(channels(r)).toEqual(['request', 'prompt', 'prompt'])
  expect('prompt' in r.requests[2]!).toBe(false)
})

test('the first prompt of a session rides on the ask right after the pack; the latest prompt wins', async () => {
  const r = rig()
  r.injector.onPrompt({ sessionID: 's1', prompt: { text: 'older prompt' } })
  r.injector.onPrompt({ sessionID: 's1', prompt: { text: 'newer prompt' } })
  await r.context()
  expect(channels(r)).toEqual(['request', 'prompt'])
  expect(r.requests[1]!.prompt).toBe('newer prompt')
})

test('concurrent requests send a waiting prompt once, and other sessions keep theirs', async () => {
  const r = rig()
  await Promise.all([r.context('s1'), r.context('s2')])
  r.injector.onPrompt({ sessionID: 's1', prompt: { text: 'for s1' } })
  r.injector.onPrompt({ sessionID: 's2', prompt: { text: 'for s2' } })
  await Promise.all([r.context('s1'), r.context('s1')])
  expect(r.requests.filter((request) => request.prompt !== undefined).map((request) => request.prompt)).toEqual(['for s1'])
  await r.context('s2')
  expect(r.requests.filter((request) => request.prompt !== undefined).map((request) => request.prompt)).toEqual(['for s1', 'for s2'])
})

test('prompt events without a session or text are ignored', async () => {
  const r = rig()
  await r.context()
  for (const bad of [null, 'x', { prompt: { text: 'no session' } }, { sessionID: 's1' }, { sessionID: 's1', prompt: { text: 7 } }, { sessionID: 's1', prompt: { text: '   ' } }]) r.injector.onPrompt(bad)
  await r.context()
  expect(channels(r)).toEqual(['request'])
})

test("a prompt's related block is shown until the next prompt's answer replaces it, while its delta part stays", async () => {
  const requests: ContextRequest[] = []
  const clock = { now: 1_000_000 }
  const answers: ContextResult[] = [
    { text: 'D1\nR1', observationIds: [1, 2], tokens: 2, relatedText: 'R1' },
    { text: 'R2', observationIds: [3], tokens: 1, relatedText: 'R2' },
    { text: 'D3', observationIds: [4], tokens: 1 },
  ]
  const injector = createContextInjector({
    host: 'opencode', cwd: '/work/repo', log: () => {}, now: () => clock.now,
    fetch: async (request) => (requests.push(request), request.channel === 'request' ? PACK : answers.shift()!),
  })
  const texts = async () => {
    const system: { type: string; text?: string }[] = []
    await injector.onContext({ sessionID: 's1', system })
    return system.map((part) => part.text)
  }
  injector.onPrompt({ sessionID: 's1', prompt: { text: 'first' } })
  expect(await texts()).toEqual([PACK.text, 'D1', 'R1'])
  expect(await texts()).toEqual([PACK.text, 'D1', 'R1'])
  injector.onPrompt({ sessionID: 's1', prompt: { text: 'second' } })
  expect(await texts()).toEqual([PACK.text, 'D1', 'R2'])
  // A promptless delta keeps the latest prompt's block.
  clock.now += DELTA_INTERVAL_MS
  expect(await texts()).toEqual([PACK.text, 'D1', 'D3', 'R2'])
})
