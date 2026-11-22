import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { SemanticAnswer } from '../vectors/search'
import { type MemoryReader, openMemoryReader } from './reader'
import type { SemanticQuery } from './semantic-client'
import { MAX_K } from '../vectors/search'
import { type McpFixture, NOW, PROJECT_A, T0, openMcpFixture, seedMcpObservation } from './test-support'
import { type ToolResult, callTool } from './tools'

let fixture: McpFixture
let reader: MemoryReader
let queries: SemanticQuery[]
beforeEach(() => {
  fixture = openMcpFixture()
  reader = openMemoryReader(fixture.dataDir)!
  queries = []
})
afterEach(() => {
  reader.close()
  fixture.cleanup()
})

async function search(args: Record<string, unknown>, answer: SemanticAnswer): Promise<ToolResult> {
  const semantic = async (query: SemanticQuery): Promise<SemanticAnswer> => {
    queries.push(query)
    return answer
  }
  const outcome = await callTool('search', args, { reader: () => reader, projectKey: PROJECT_A, now: () => NOW, semantic })
  return outcome!.result
}
const ids = (result: ToolResult) => (result.structuredContent.results as { id: number }[]).map((row) => row.id)
const hits = (...pairs: [number, number][]): SemanticAnswer => ({ status: 'ok', hits: pairs.map(([id, distance]) => ({ id, distance })), embedMs: 1, searchMs: 1, cached: false })

test('a semantic match with no shared words is found, after the keyword matches it does not share', async () => {
  const result = await search({ query: 'parser' }, hits([fixture.ids.spool!, 0.3]))
  expect(ids(result)).toContain(fixture.ids.spool!)
  expect(ids(result)[0]).not.toBe(fixture.ids.spool!)
  expect(result.structuredContent.semantic).toBe('used')
  expect(result.content[0]!.text).toContain('keyword and semantic matches')
})

test('the daemon gets the raw query, the scope, the filters and the same k on every page', async () => {
  await search({ query: 'parser quotes', limit: 5, offset: 10, type: 'decision' }, hits())
  await search({ query: 'parser quotes', limit: 5, type: 'decision' }, hits())
  const sent = { query: 'parser quotes', project: PROJECT_A, k: MAX_K, filters: { type: 'decision', host: null, evidence: null } }
  expect(queries).toEqual([sent, sent])
})

test('paging a deep fused ranking shows every row once', async () => {
  for (let n = 0; n < 40; n += 1) seedMcpObservation(fixture.store, { sessionId: fixture.sessionA, projectKey: PROJECT_A, title: `bulk parser note ${n}`, at: T0 + n })
  reader.close()
  reader = openMemoryReader(fixture.dataDir)!
  const vectorIds = (fixture.store.db.query('SELECT id FROM observations ORDER BY id').all() as { id: number }[]).map((row) => row.id)
  const answer = hits(...vectorIds.map((id, rank): [number, number] => [id, 0.1 + rank / 100]))
  const pages = async (limit: number): Promise<number[]> => {
    const out: number[] = []
    for (let offset = 0; offset < 42; offset += limit) out.push(...ids(await search({ query: 'parser', limit, offset }, answer)))
    return out.slice(0, 42)
  }
  const bySeven = await pages(7)
  expect(bySeven).toHaveLength(42)
  expect(new Set(bySeven).size).toBe(42)
  expect(bySeven).toEqual(await pages(20))
})

test('vector hits obey the scope and filters: another project, or another type, never shows', async () => {
  const result = await search({ query: 'nothingmatcheshere', type: 'decision' }, hits([fixture.ids.other!, 0.1], [fixture.ids.parser!, 0.1], [fixture.ids.spool!, 0.2]))
  expect(ids(result)).toEqual([fixture.ids.spool!])
})

test('when semantic search is unavailable the keyword results stand and the reason is shown', async () => {
  const keywordOnly = ids(await search({ query: 'parser' }, { status: 'unavailable', reason: 'no Homebrew SQLite found' }))
  const result = await search({ query: 'parser' }, { status: 'unavailable', reason: 'no Homebrew SQLite found' })
  expect(ids(result)).toEqual(keywordOnly)
  expect(keywordOnly.length).toBeGreaterThan(0)
  expect(result.structuredContent).toMatchObject({ semantic: 'unavailable', semanticReason: 'no Homebrew SQLite found' })
  expect(result.content[0]!.text).toContain('keyword matches only (no Homebrew SQLite found)')
  expect((await search({ query: 'parser' }, { status: 'timeout', ms: 1500 })).content[0]!.text).toContain('semantic search timed out')
})

test('pages are slices of one fused ranking', async () => {
  const answer = hits([fixture.ids.tests!, 0.1], [fixture.ids.spool!, 0.2], [fixture.ids.redaction!, 0.3])
  const all = ids(await search({ query: 'parser', limit: 20 }, answer))
  const first = ids(await search({ query: 'parser', limit: 2 }, answer))
  const second = ids(await search({ query: 'parser', limit: 2, offset: 2 }, answer))
  expect([...first, ...second]).toEqual(all.slice(0, 4))
})
