import { afterEach, beforeEach, expect, test } from 'bun:test'
import { insertLinks } from '../store/observation-links'
import { writeSharedSummary } from '../store/summary-share'
import { insertPrompt } from '../store/writes'
import { type MemoryReader, openMemoryReader } from './reader'
import { type McpFixture, NOW, PROJECT_A, T0, openMcpFixture, seedMcpObservation, seedMcpSession } from './test-support'
import { type ToolResult, callTool } from './tools'

// Shared summaries in MCP answers: search ranks a confirmed match higher and says
// "confirmed by N"; a shared summary appears once with its repeat count.

let fixture: McpFixture
let reader: MemoryReader | null
beforeEach(() => {
  fixture = openMcpFixture()
  reader = openMemoryReader(fixture.dataDir)
})
afterEach(() => {
  reader?.close()
  fixture.cleanup()
})

async function call(name: string, args: unknown): Promise<ToolResult> {
  const outcome = await callTool(name, args, { reader: () => reader, projectKey: PROJECT_A, now: () => NOW })
  if (outcome === null) throw new Error(`no tool ${name}`)
  return outcome.result
}

const text = (result: ToolResult) => result.content[0]!.text
const ids = (result: ToolResult) => (result.structuredContent.results as { id: number }[]).map((row) => row.id)
const seed = (title: string, at: number) => seedMcpObservation(fixture.store, { sessionId: fixture.sessionA, projectKey: PROJECT_A, title, at })

test('search ranks a confirmed match above an equal one and labels it; a contradicted confirmer stops counting', async () => {
  const older = seed('Widget cache alpha', T0 + 10)
  const newer = seed('Widget cache bravo', T0 + 20)
  expect(ids(await call('search', { query: 'widget' }))).toEqual([newer, older])
  const confirmer = seed('Unrelated confirmer note', T0 + 30)
  insertLinks(fixture.store.db, confirmer, [{ kind: 'confirms', observationId: older }], NOW)
  const boosted = await call('search', { query: 'widget' })
  expect(ids(boosted)).toEqual([older, newer])
  expect(text(boosted)).toContain(`#${older} · claude-code · discovery · tool-verified · 2h · Widget cache alpha (confirmed by 1)`)
  expect((boosted.structuredContent.results as { confirmedBy: number }[]).map((row) => row.confirmedBy)).toEqual([1, 0])

  fixture.store.db.query('UPDATE observations SET contradicted_by = $by WHERE id = $id').run({ id: confirmer, by: newer })
  expect(ids(await call('search', { query: 'widget' }))).toEqual([newer, older])
})

test('the contradiction label wins over "confirmed by" (D2)', async () => {
  const target = fixture.ids.oldParser!
  insertLinks(fixture.store.db, fixture.ids.tests!, [{ kind: 'confirms', observationId: target }], NOW)
  const line = text(await call('search', { query: 'never drops' })).split('\n').find((entry) => entry.startsWith(`#${target}`))
  expect(line).toContain(`(contradicted by #${fixture.ids.parser})`)
  expect(line).not.toContain('confirmed by')
})

function seedRepeats(): { other: number } {
  const other = seedMcpSession(fixture.store, PROJECT_A, 'opencode', 'a-2')
  const notice = 'Coordinator notice: worker done.'
  const turns: [number, number, number][] = [[fixture.sessionA, 7, T0 + 60_000], [fixture.sessionA, 8, T0 + 61_000], [other, 1, T0 + 62_000]]
  for (const [sessionId, promptNumber, at] of turns) {
    insertPrompt(fixture.store.db, { sessionId, promptNumber, text: notice, occurredAt: at })
    const summary = { request: 'read the worker report', learned: 'l', completed: 'c', nextSteps: 'n' }
    writeSharedSummary(fixture.store.db, { sessionId, projectKey: PROJECT_A, promptNumber, summary, occurredAt: at, now: at })
  }
  return { other }
}

test('a session timeline shows a shared summary once, with ×N, in every session that used it', async () => {
  const { other } = seedRepeats()
  for (const sessionId of [fixture.sessionA, other]) {
    const result = await call('timeline', { sessionId })
    const lines = text(result).split('\n').filter((line) => line.includes('read the worker report'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`session ${fixture.sessionA} prompt 7 · ×3 identical prompts`)
    const items = result.structuredContent.items as { kind: string; repeatCount?: number }[]
    expect(items.filter((item) => item.kind === 'summary' && item.repeatCount === 3)).toHaveLength(1)
  }
})

test('an anchor timeline lists the shared summary as one row', async () => {
  seedRepeats()
  const result = await call('timeline', { anchorId: fixture.ids.tests, before: 20, after: 20 })
  expect(text(result).split('\n').filter((line) => line.includes('read the worker report'))).toHaveLength(1)
})
