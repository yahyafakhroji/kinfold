import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type TempStore, openTempStore } from '../observer/test-support'
import { EmbedError } from '../../vectors/embedder'
import { MAX_DEADLINE_MS, MAX_K, MAX_QUERY_CHARS, createSemanticSearch, parseSemanticRequest } from '../../vectors/search'
import { fakeEmbedder } from './test-support'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('sam-semantic-')
})
afterEach(() => temp.cleanup())

const REQUEST = { query: 'parser quotes', project: 'org/repo', k: 5, deadlineMs: 100, filters: { type: null, host: null, evidence: null } }

test('a request needs a query, a project or null, and k; the deadline defaults', () => {
  expect(parseSemanticRequest({ query: '  parser  ', project: null, k: 3 })).toEqual({ ok: true, value: { query: 'parser', project: null, k: 3, deadlineMs: 1_500, filters: { type: null, host: null, evidence: null } } })
  expect(parseSemanticRequest({ query: 'x', project: null, k: 3, filters: { type: 'bugfix' } })).toMatchObject({ ok: true, value: { filters: { type: 'bugfix', host: null, evidence: null } } })
  for (const bad of [
    null, [], { project: null, k: 3 }, { query: ' ', project: null, k: 3 }, { query: 'x'.repeat(MAX_QUERY_CHARS + 1), project: null, k: 3 },
    { query: 'x', project: '', k: 3 }, { query: 'x', project: 7, k: 3 }, { query: 'x', project: null, k: 0 }, { query: 'x', project: null, k: MAX_K + 1 },
    { query: 'x', project: null, k: 1.5 }, { query: 'x', project: null, k: 3, deadlineMs: MAX_DEADLINE_MS + 1 },
    { query: 'x', project: null, k: 3, filters: 'bugfix' }, { query: 'x', project: null, k: 3, filters: { type: 7 } }, { query: 'x', project: null, k: 3, filters: { host: 'h'.repeat(65) } },
  ]) expect(parseSemanticRequest(bad).ok).toBe(false)
})

test('without sqlite-vec the answer is unavailable with the loader reason, and nothing is embedded', async () => {
  const embedder = fakeEmbedder()
  const search = createSemanticSearch({ db: temp.store.db, embedder, support: { ok: false, reason: 'no Homebrew SQLite found' } })
  expect(await search(REQUEST)).toEqual({ status: 'unavailable', reason: 'no Homebrew SQLite found' })
  expect(embedder.calls).toHaveLength(0)
})

test('without an embedder the answer names the missing key', async () => {
  const search = createSemanticSearch({ db: temp.store.db, embedder: null, support: { ok: true, detail: 'sqlite-vec v0.1.9' } })
  expect(await search(REQUEST)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('OpenRouter key') })
})

test('an embed timeout is a timeout answer, and any other embed failure is unavailable with its message', async () => {
  const embedder = fakeEmbedder()
  const search = createSemanticSearch({ db: temp.store.db, embedder, support: { ok: true, detail: 'sqlite-vec v0.1.9' } })
  embedder.failures.push(new EmbedError('timeout', 'request failed (TimeoutError)'), new EmbedError('http_error', 'openrouter answered 429'))
  expect(await search(REQUEST)).toMatchObject({ status: 'timeout' })
  expect(await search(REQUEST)).toEqual({ status: 'unavailable', reason: 'the query could not be embedded (openrouter answered 429)' })
})

test('the query is embedded as a query, so a local model puts it ahead of indexing', async () => {
  const purposes: (string | undefined)[] = []
  const embedder = { model: 'm', dims: 2, embed: async (texts: readonly string[], _signal?: AbortSignal, purpose?: 'query' | 'index') => (purposes.push(purpose), texts.map(() => new Float32Array(2))) }
  const search = createSemanticSearch({ db: temp.store.db, embedder, support: { ok: true, detail: 'sqlite-vec v0.1.9' } })
  await search(REQUEST)
  expect(purposes).toEqual(['query'])
})

test('the embedder is asked for at each search; none gives its reason, and a new one does not reuse the old cache', async () => {
  let current: { embedder: ReturnType<typeof fakeEmbedder> | null; reason: string } = { embedder: null, reason: 'the new space is still being built' }
  const search = createSemanticSearch({ db: temp.store.db, embedder: null, embedderFor: () => current, support: { ok: true, detail: 'sqlite-vec v0.1.9' } })
  expect(await search(REQUEST)).toEqual({ status: 'unavailable', reason: 'the new space is still being built' })
  const first = fakeEmbedder('one')
  current = { embedder: first, reason: '' }
  await search(REQUEST)
  const second = fakeEmbedder('two')
  current = { embedder: second, reason: '' }
  await search(REQUEST)
  expect([first.calls.length, second.calls.length]).toEqual([1, 1])
})
