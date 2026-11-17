import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type TempStore, openTempStore } from '../observer/test-support'
import { recordInjection } from '../store/context-store'
import { upsertProject, upsertSession } from '../store/writes'
import type { SemanticAnswer, SemanticRequest } from '../vectors/search'
import { inlineStoreReader } from '../workers/store-reader'
import { createLateMatches } from './late-matches'
import { type PromptContextDeps, RELATED_VECTOR_K, createEmbedSlots, preparePromptContext } from './prompt-context'
import { NARRATIVE_MARKER, contradict, seedObservation } from './test-support'
import type { ContextRequest } from './types'

const CWD = '/work/prompt-repo'
const T0 = 1_792_900_000_000

let temp: TempStore
let other: number
let logs: string[]
beforeEach(() => {
  temp = openTempStore('sam-prompt-ctx-')
  logs = []
  upsertProject(temp.store.db, { key: CWD, kind: 'path', displayName: 'prompt-repo' }, T0)
  upsertSession(temp.store.db, { host: 'claude-code', hostSessionId: 'cc-me', projectKey: CWD, cwd: CWD, occurredAt: T0 })
  other = upsertSession(temp.store.db, { host: 'opencode', hostSessionId: 'oc-old', projectKey: CWD, cwd: CWD, occurredAt: T0 - 10_000 })
})
afterEach(() => temp.cleanup())

/** Written before this session started, so never part of the delta. */
const earlier = (title: string): number => seedObservation(temp.store, { sessionId: other, projectKey: CWD, host: 'opencode', title, at: T0 - 5_000 })
const ask = (prompt: string): ContextRequest => ({ host: 'claude-code', cwd: CWD, hostSessionId: 'cc-me', channel: 'prompt', prompt })
const atLeastTwoTerms = (c: { matchedTerms: number; distance: number | null }): boolean => c.matchedTerms >= 2 || (c.distance !== null && c.distance < 0.5)

function deps(semantic: PromptContextDeps['semantic'], extra: Partial<PromptContextDeps> = {}): PromptContextDeps {
  return { db: temp.store.db, semantic, late: createLateMatches(), log: (line) => logs.push(line), gate: atLeastTwoTerms, deadlineMs: 30, now: () => T0, ...extra }
}

/** A semantic search that answers with `hits` after `ms`, recording what it was asked. */
function fakeSemantic(hits: () => { id: number; distance: number }[], ms = 0) {
  const asked: SemanticRequest[] = []
  const search = async (request: SemanticRequest): Promise<SemanticAnswer> => {
    asked.push(request)
    await Bun.sleep(ms)
    return { status: 'ok', hits: hits(), embedMs: ms, searchMs: 0, cached: false }
  }
  return { asked, search }
}

test('keyword matches pass the gate, are framed after the delta, and never carry the narrative', async () => {
  const strong = earlier('CSV parser drops quotes on export')
  earlier('Unrelated deploy note about quotes')
  const answer = await preparePromptContext(deps(null), ask('why does the csv parser drop quotes?'), CWD, T0)
  expect(answer.observationIds).toEqual([strong])
  expect(answer.text).toContain('(matched by keyword)')
  expect(answer.text).not.toContain(NARRATIVE_MARKER)
  expect(answer).toMatchObject({ related: 1, semantic: 'off' })
})

test('rows already sent to the session, and contradicted rows, are never related', async () => {
  const sent = earlier('CSV parser drops quotes on export')
  const stale = earlier('CSV parser quotes fixed in v1')
  contradict(temp.store, stale, sent)
  recordInjection(temp.store.db, { sessionId: null, host: 'claude-code', hostSessionId: 'cc-me', projectKey: CWD, observationIds: [sent], channel: 'session_start', tokens: 1, occurredAt: T0 })
  const answer = await preparePromptContext(deps(null), ask('csv parser quotes'), CWD, T0)
  expect(answer.observationIds).toEqual([])
  expect(answer.text).toBe('')
})

test('a vector answer in time joins this prompt, scoped to the project, with the prompt as the query', async () => {
  const meaning = earlier('Exporter mangles delimited text')
  const { asked, search } = fakeSemantic(() => [{ id: meaning, distance: 0.3 }])
  const answer = await preparePromptContext(deps(search), ask('why does the csv parser drop quotes?'), CWD, T0)
  expect(answer.observationIds).toEqual([meaning])
  expect(answer.text).toContain('(matched by keyword and meaning)')
  expect(answer.semantic).toBe('ok')
  expect(asked[0]).toMatchObject({ query: 'why does the csv parser drop quotes?', project: CWD })
})

test('a late vector answer is parked and offered with the next prompt, unless sent by then', async () => {
  const meaning = earlier('Exporter mangles delimited text')
  const late = createLateMatches()
  const { search } = fakeSemantic(() => [{ id: meaning, distance: 0.3 }], 80)
  const first = await preparePromptContext(deps(search, { late }), ask('csv quotes problem'), CWD, T0)
  expect(first).toMatchObject({ semantic: 'late', observationIds: [] })
  await Bun.sleep(120)
  expect(logs.some((line) => line.startsWith('prompt semantic late status=ok hits=1'))).toBe(true)
  const second = await preparePromptContext(deps(null, { late }), ask('anything else'), CWD, T0 + 1)
  expect(second.observationIds).toEqual([meaning])
  expect(second.text).toContain('meaning from the previous prompt')
})

test('a prompt the redaction rules flag is never embedded and still gets keyword matches', async () => {
  const strong = earlier('Rotated the deploy token after leak')
  const { asked, search } = fakeSemantic(() => [])
  const answer = await preparePromptContext(deps(search), ask('rotated deploy token API_KEY=Zx81kQpL0vN3mR7tY2wB5cD9fG4hJ6sA'), CWD, T0)
  expect(asked).toHaveLength(0)
  expect(answer).toMatchObject({ semantic: 'secret', observationIds: [strong] })
})

test('a failing vector search is reported, not thrown, and no log line holds the prompt', async () => {
  earlier('CSV parser drops quotes on export')
  const answer = await preparePromptContext(deps(async () => { throw new Error('boom') }), ask('csv parser quotes SECRET-PROMPT-WORDS'), CWD, T0)
  expect(answer.semantic).toBe('unavailable')
  expect(logs.join('\n')).not.toContain('SECRET-PROMPT-WORDS')
})

test("this session's own observations are never related memory, on either side", async () => {
  const me = (temp.store.db.query("SELECT id FROM sessions WHERE host_session_id = 'cc-me'").get() as { id: number }).id
  const own = seedObservation(temp.store, { sessionId: me, projectKey: CWD, host: 'claude-code', title: 'CSV parser drops quotes on export', at: T0 + 1 })
  const theirs = earlier('CSV parser quotes broke the exporter')
  const { search } = fakeSemantic(() => [{ id: own, distance: 0.1 }, { id: theirs, distance: 0.3 }])
  const answer = await preparePromptContext(deps(search), ask('csv parser quotes'), CWD, T0)
  expect(answer.observationIds).toEqual([theirs])
})

test('the vector search is asked for more than can be served, since sent and own rows drop out after', async () => {
  const { asked, search } = fakeSemantic(() => [])
  await preparePromptContext(deps(search), ask('csv parser quotes'), CWD, T0)
  expect(asked[0]!.k).toBe(RELATED_VECTOR_K)
})

test('the semantic deadline counts from when the request arrived, not from after the keyword work', async () => {
  const meaning = earlier('Exporter mangles delimited text')
  const { search } = fakeSemantic(() => [{ id: meaning, distance: 0.3 }], 40)
  // 100 ms of the 120 ms budget are already spent when the race starts.
  const answer = await preparePromptContext(deps(search, { deadlineMs: 120, clock: () => 100 }), ask('csv quotes problem'), CWD, T0, 0)
  expect(answer.semantic).toBe('late')
  const inTime = await preparePromptContext(deps(search, { deadlineMs: 120, clock: () => 0 }), ask('csv quotes problem'), CWD, T0, 0)
  expect(inTime.semantic).toBe('ok')
})

test('a failure in the related half keeps the delta and logs the error name only', async () => {
  const fresh = seedObservation(temp.store, { sessionId: other, projectKey: CWD, host: 'opencode', title: 'New note after start', at: T0 + 10 })
  earlier('CSV parser drops quotes on export')
  const answer = await preparePromptContext(deps(null, { gate: () => { throw new TypeError('PROMPT-ECHO csv') } }), ask('csv parser quotes'), CWD, T0 + 20)
  expect(answer).toMatchObject({ semantic: 'error', related: 0, relatedText: '' })
  expect(answer.observationIds).toEqual([fresh])
  expect(logs).toContain('prompt related failed: TypeError')
  expect(logs.join('\n')).not.toContain('PROMPT-ECHO')
})

test('with every embed slot taken a prompt is not embedded, and a finished embed frees its slot', async () => {
  const slots = createEmbedSlots(1)
  const { asked, search } = fakeSemantic(() => [], 60)
  const first = await preparePromptContext(deps(search, { slots }), ask('csv quotes'), CWD, T0)
  expect(first.semantic).toBe('late')
  const second = await preparePromptContext(deps(search, { slots }), ask('csv quotes'), CWD, T0)
  expect(second.semantic).toBe('busy')
  expect(asked).toHaveLength(1)
  await Bun.sleep(80)
  expect((await preparePromptContext(deps(search, { slots, deadlineMs: 200 }), ask('csv quotes'), CWD, T0)).semantic).toBe('ok')
})

test("this prompt's distance wins over a parked one for the same row, and the block names only this prompt's meaning", async () => {
  const row = earlier('Exporter mangles delimited text')
  const late = createLateMatches()
  late.put('claude-code\u0000cc-me', [{ id: row, distance: 0.1, matchedTerms: 0, promptTerms: 2 }], T0)
  const { search } = fakeSemantic(() => [{ id: row, distance: 0.9 }])
  const seen: (number | null)[] = []
  const gate = (c: { distance: number | null }) => (seen.push(c.distance), c.distance !== null && c.distance < 0.5)
  const answer = await preparePromptContext(deps(search, { late, gate }), ask('zebra giraffe'), CWD, T0)
  expect(seen).toEqual([0.9])
  expect(answer.observationIds).toEqual([])
})

test('the related block is returned alone as the end of the text', async () => {
  const fresh = seedObservation(temp.store, { sessionId: other, projectKey: CWD, host: 'opencode', title: 'New note after start', at: T0 + 10 })
  const strong = earlier('CSV parser drops quotes on export')
  const answer = await preparePromptContext(deps(null), ask('csv parser quotes'), CWD, T0 + 20)
  expect(answer.observationIds).toEqual([fresh, strong])
  expect(answer.relatedText).toContain('(matched by keyword)')
  expect(answer.text.endsWith(answer.relatedText)).toBe(true)
  expect(answer.text.length).toBeGreaterThan(answer.relatedText.length)
})

test('the log carries the closest distances and the guard rules, never the prompt', async () => {
  const meaning = earlier('Exporter mangles delimited text')
  const { search } = fakeSemantic(() => [{ id: meaning, distance: 0.4123 }])
  await preparePromptContext(deps(search), ask('csv PROMPT-WORDS quotes'), CWD, T0)
  expect(logs).toContain('prompt semantic ok hits=1 embed_ms=0 top=0.412/0')
  await preparePromptContext(deps(search), ask('rotated API_KEY=Zx81kQpL0vN3mR7tY2wB5cD9fG4hJ6sA PROMPT-WORDS'), CWD, T0)
  expect(logs.some((line) => /^prompt guard rules=[a-z_,]+$/.test(line))).toBe(true)
  expect(logs.join('\n')).not.toContain('PROMPT-WORDS')
  expect(logs.join('\n')).not.toContain('Zx81kQ')
})

test('keyword candidates are measured too, so one far from the prompt in meaning is vetoed even outside the top k', async () => {
  const near = earlier('CSV parser drops quotes on export')
  const far = earlier('CSV parser quotes in the release checklist')
  const asked: SemanticRequest[] = []
  const search = async (request: SemanticRequest): Promise<SemanticAnswer> => {
    asked.push(request)
    // The top k holds only `near`; `far` comes back as an extra, far away in meaning.
    return { status: 'ok', hits: [{ id: near, distance: 0.3 }, { id: far, distance: 0.95 }], embedMs: 0, searchMs: 0, cached: false }
  }
  const answer = await preparePromptContext(deps(search, { gate: undefined }), ask('csv parser quotes'), CWD, T0)
  expect(await asked[0]!.alsoIds).toEqual(expect.arrayContaining([near, far]))
  expect(answer.observationIds).toEqual([near])
})

test('each served related line carries the distance and terms that earned it, for the labels table', async () => {
  const strong = earlier('CSV parser drops quotes on export')
  const { search } = fakeSemantic(() => [{ id: strong, distance: 0.31 }])
  const answer = await preparePromptContext(deps(search), ask('why does the csv parser drop quotes?'), CWD, T0)
  expect(answer.relatedServed).toEqual([{ observationId: strong, distance: 0.31, matchedTerms: expect.any(Number) }])
  expect(answer.relatedServed[0]!.matchedTerms).toBeGreaterThan(0)
})

test('explain() says what the search weighed and why each candidate was sent or not', async () => {
  const strong = earlier('CSV parser drops quotes on export')
  const weak = earlier('Release notes mention quotes')
  const delivered = earlier('Exporter mangles delimited text')
  recordInjection(temp.store.db, { sessionId: null, host: 'claude-code', hostSessionId: 'cc-me', projectKey: CWD, observationIds: [delivered], channel: 'session_start', tokens: 1, occurredAt: T0 })
  const search = async (): Promise<SemanticAnswer> => ({
    status: 'ok', embedMs: 1, searchMs: 1, cached: false, model: 'local/bge-small',
    hits: [{ id: delivered, distance: 0.2 }, { id: 987_654, distance: 0.3 }, { id: weak, distance: 0.9 }],
  })
  const answer = await preparePromptContext(deps(search, { gate: undefined }), ask('why does the csv parser drop quotes?'), CWD, T0)
  expect(answer.observationIds).toEqual([strong])
  const explained = await answer.explain()
  expect(explained).toMatchObject({ semantic: 'ok', space: 'local/bge-small', query: 'why does the csv parser drop quotes?', mode: 'keyword and meaning' })
  expect(explained!.terms).toContain('csv')
  const byId = new Map(explained!.candidates.map((candidate) => [candidate.id, candidate]))
  expect(byId.get(strong)).toMatchObject({ outcome: 'sent', source: 'keyword', title: 'CSV parser drops quotes on export' })
  expect(byId.get(weak)).toMatchObject({ outcome: 'below cutoff', distance: 0.9 })
  expect(byId.get(weak)!.rule).toContain('0.70')
  expect(byId.get(delivered)).toMatchObject({ outcome: 'already delivered', title: 'Exporter mangles delimited text' })
  expect(byId.get(987_654)).toMatchObject({ outcome: 'not current here' })
  // Sent lines come first.
  expect(explained!.candidates[0]!.id).toBe(strong)
})

test('explain() marks a candidate the gate passed but the budget had no room for', async () => {
  const ids = Array.from({ length: 6 }, (_, n) => earlier(`CSV parser quotes ${n} ${'detail '.repeat(18)}`))
  const answer = await preparePromptContext(deps(null), ask('csv parser quotes'), CWD, T0)
  const outcomes = (await answer.explain())!.candidates.filter((candidate) => ids.includes(candidate.id)).map((candidate) => candidate.outcome)
  expect(outcomes).toContain('sent')
  expect(outcomes).toContain('over budget')
  expect(await answer.explain()).toMatchObject({ semantic: 'off', space: null, query: '' })
})

test('explain() is null when no related search ran', async () => {
  const answer = await preparePromptContext(deps(null), ask('   '), CWD, T0)
  expect(await answer.explain()).toBeNull()
})

test('explain() names a keyword match the session already has as already delivered', async () => {
  const sent = earlier('CSV parser drops quotes on export')
  recordInjection(temp.store.db, { sessionId: null, host: 'claude-code', hostSessionId: 'cc-me', projectKey: CWD, observationIds: [sent], channel: 'session_start', tokens: 1, occurredAt: T0 })
  const answer = await preparePromptContext(deps(null), ask('why does the csv parser drop quotes?'), CWD, T0)
  expect(answer.observationIds).toEqual([])
  expect((await answer.explain())!.candidates).toEqual([{ id: sent, title: 'CSV parser drops quotes on export', source: 'keyword', distance: null, matchedTerms: 3, outcome: 'already delivered' }])
})

test('explain() leaves out memory this prompt sends as new; the trace lists it under new instead', async () => {
  const fresh = seedObservation(temp.store, { sessionId: other, projectKey: CWD, host: 'opencode', title: 'CSV parser quotes fixed today', at: T0 + 500 })
  const answer = await preparePromptContext(deps(null), ask('csv parser quotes'), CWD, T0 + 1_000)
  expect(answer.observationIds).toContain(fresh)
  expect((await answer.explain())!.candidates.map((candidate) => candidate.id)).not.toContain(fresh)
})

/** The store reads on this test's connection, the recall read held back for `ms`. */
function slowReads(ms: number): PromptContextDeps['reads'] {
  const inline = inlineStoreReader(temp.store.db, temp.store.path)
  return {
    ...inline,
    run: async (op, args, options) => {
      if (op === 'recallPrompt') await Bun.sleep(ms)
      return inline.run(op, args, options)
    },
  }
}

test('a recall read past the deadline is answered with nothing in time, and its keyword matches come with the next prompt', async () => {
  const strong = earlier('CSV parser drops quotes on export')
  const late = createLateMatches()
  const startedAt = performance.now()
  const slow = await preparePromptContext(deps(null, { late, reads: slowReads(150), deadlineMs: 40 }), ask('why does the csv parser drop quotes?'), CWD, T0)
  expect(performance.now() - startedAt).toBeLessThan(120)
  expect(slow).toMatchObject({ text: '', observationIds: [], read: 'late' })
  await Bun.sleep(200)
  const next = await preparePromptContext(deps(null, { late }), ask('anything else to check?'), CWD, T0 + 1)
  expect(next.observationIds).toEqual([strong])
  expect(next.text).toContain('from the previous prompt')
})

test('the embedder is asked with the prompt\'s own words and paste, never a wrapper tag or its id', async () => {
  const { asked, search } = fakeSemantic(() => [])
  await preparePromptContext(deps(search), ask('why does it fail <pasted_content id="bb24">\nbuild log\n</pasted_content id="bb24">'), CWD, T0)
  expect(asked[0]!.query).toBe('why does it fail\nbuild log')
})
