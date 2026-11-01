import { expect, test } from 'bun:test'
import { DEFAULT_EMBED_DIMS, DEFAULT_EMBED_MODEL, EmbedError, OPENROUTER_EMBEDDINGS_ENDPOINT, REREAD_COOLDOWN_MS, createOpenRouterEmbedder, parseEmbeddings } from './embedder'

const KEY = 'sk-or-test-not-a-real-key'

function recordingFetch(answer: () => Response) {
  const requests: { url: string; init: RequestInit }[] = []
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    requests.push({ url, init })
    return answer()
  }
  return { requests, fetchFn }
}

const reply = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const vectorOf = (n: number, value = 0.1): number[] => new Array(n).fill(value)

test('one POST with the model, the inputs, 512 dims and float encoding; the key only in the Authorization header', async () => {
  const { requests, fetchFn } = recordingFetch(() => reply({ data: [{ index: 0, embedding: vectorOf(DEFAULT_EMBED_DIMS) }, { index: 1, embedding: vectorOf(DEFAULT_EMBED_DIMS) }] }))
  const embedder = createOpenRouterEmbedder({ apiKey: KEY, fetch: fetchFn })
  const vectors = await embedder.embed(['first text', 'second text'])
  expect(vectors.map((vector) => vector.length)).toEqual([DEFAULT_EMBED_DIMS, DEFAULT_EMBED_DIMS])
  expect(requests).toHaveLength(1)
  expect(requests[0]!.url).toBe(OPENROUTER_EMBEDDINGS_ENDPOINT)
  expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ model: DEFAULT_EMBED_MODEL, input: ['first text', 'second text'], dimensions: 512, encoding_format: 'float' })
  expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
  expect(String(requests[0]!.init.body)).not.toContain(KEY)
})

test('no inputs means no call', async () => {
  const { requests, fetchFn } = recordingFetch(() => reply({ data: [] }))
  expect(await createOpenRouterEmbedder({ apiKey: KEY, fetch: fetchFn }).embed([])).toEqual([])
  expect(requests).toHaveLength(0)
})

test('vectors are placed by index, not by position', () => {
  const [first, second] = parseEmbeddings({ data: [{ index: 1, embedding: [2, 2] }, { index: 0, embedding: [1, 1] }] }, 2, 2)
  expect([...first!]).toEqual([1, 1])
  expect([...second!]).toEqual([2, 2])
})

test.each([
  ['no data', {}],
  ['a missing item', { data: [{ index: 0, embedding: [1, 1] }] }],
  ['the wrong dims', { data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 1] }] }],
  ['a non-finite value', { data: [{ index: 0, embedding: [1, null] }, { index: 1, embedding: [1, 1] }] }],
  ['an index out of range', { data: [{ index: 0, embedding: [1, 1] }, { index: 5, embedding: [1, 1] }] }],
])('a response with %s is a bad_response', (_name, body) => {
  expect(() => parseEmbeddings(body, 2, 2)).toThrow(EmbedError)
})

test('an HTTP error carries the status and never the body or the key', async () => {
  const { fetchFn } = recordingFetch(() => reply({ error: { message: `bad key ${KEY}` } }, 401))
  const error = await createOpenRouterEmbedder({ apiKey: KEY, fetch: fetchFn }).embed(['x']).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(EmbedError)
  expect((error as EmbedError).kind).toBe('http_error')
  expect((error as EmbedError).message).toBe('openrouter answered 401')
})

test('an aborted call is a timeout', async () => {
  const fetchFn = async (_url: string, init: RequestInit): Promise<Response> => {
    await new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))
    return reply({})
  }
  const error = await createOpenRouterEmbedder({ apiKey: KEY, fetch: fetchFn }).embed(['x'], AbortSignal.timeout(5)).catch((e: unknown) => e)
  expect((error as EmbedError).kind).toBe('timeout')
})

const NEW_KEY = 'sk-or-test-replacement-key'
const bearer = (init: RequestInit): string => (init.headers as Record<string, string>).authorization!
const okFor = (count: number) => reply({ data: Array.from({ length: count }, (_, index) => ({ index, embedding: vectorOf(DEFAULT_EMBED_DIMS) })) })

test('a 401 re-reads the key, retries once with the new one, and keeps it for later calls', async () => {
  const { requests, fetchFn } = recordingFetch(() => (bearer(requests.at(-1)!.init) === `Bearer ${NEW_KEY}` ? okFor(1) : reply({}, 401)))
  let reads = 0
  const embedder = createOpenRouterEmbedder({ apiKey: KEY, fetch: fetchFn, rereadKey: () => (reads += 1, NEW_KEY) })
  expect(await embedder.embed(['x'])).toHaveLength(1)
  expect(await embedder.embed(['y'])).toHaveLength(1)
  expect(requests.map((request) => bearer(request.init))).toEqual([`Bearer ${KEY}`, `Bearer ${NEW_KEY}`, `Bearer ${NEW_KEY}`])
  expect(reads).toBe(1)
})

test.each([
  ['the same key', () => KEY],
  ['no keychain entry', () => null],
  ['a keychain failure', () => { throw new Error('security exited 44') }],
])('a 401 with %s on re-read is not retried and stays a 401', async (_name, rereadKey) => {
  const { requests, fetchFn } = recordingFetch(() => reply({}, 401))
  const error = await createOpenRouterEmbedder({ apiKey: KEY, fetch: fetchFn, rereadKey }).embed(['x']).catch((e: unknown) => e)
  expect((error as EmbedError).message).toBe('openrouter answered 401')
  expect(requests).toHaveLength(1)
})

test('other errors never re-read the key', async () => {
  let reads = 0
  const { fetchFn } = recordingFetch(() => reply({}, 429))
  await createOpenRouterEmbedder({ apiKey: KEY, fetch: fetchFn, rereadKey: () => (reads += 1, NEW_KEY) }).embed(['x']).catch(() => undefined)
  expect(reads).toBe(0)
})

test('a new key that also gets a 401 is still adopted, so the next 401 compares against it', async () => {
  const { requests, fetchFn } = recordingFetch(() => reply({}, 401))
  const embedder = createOpenRouterEmbedder({ apiKey: KEY, fetch: fetchFn, rereadKey: () => NEW_KEY })
  await embedder.embed(['x']).catch(() => undefined)
  await embedder.embed(['y']).catch(() => undefined)
  expect(requests.map((request) => bearer(request.init))).toEqual([`Bearer ${KEY}`, `Bearer ${NEW_KEY}`, `Bearer ${NEW_KEY}`])
})

test('a 401 with an unchanged key re-reads at most once per cooldown, since the read is a synchronous spawn', async () => {
  const { fetchFn } = recordingFetch(() => reply({}, 401))
  const clock = { now: 1_000 }
  let reads = 0
  const embedder = createOpenRouterEmbedder({ apiKey: KEY, fetch: fetchFn, now: () => clock.now, rereadKey: () => (reads += 1, KEY) })
  for (let i = 0; i < 3; i += 1) await embedder.embed(['x']).catch(() => undefined)
  expect(reads).toBe(1)
  clock.now += REREAD_COOLDOWN_MS
  await embedder.embed(['x']).catch(() => undefined)
  expect(reads).toBe(2)
})
