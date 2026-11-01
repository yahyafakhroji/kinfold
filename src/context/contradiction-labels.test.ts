import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { indexLine } from '../mcp/format'
import { ftsMatch } from '../mcp/fts'
import { openMemoryReader } from '../mcp/reader'
import { PROJECT, type TempStore, T0, openTempStore, seedSession } from '../observer/test-support'
import { openTestDatabase } from '../sqlite/test-support'
import { insertLinks, settleContradictions } from '../store/observation-links'
import { MIGRATIONS } from '../store/schema'
import { rebuildPack } from './packs'
import { contradictionLabel } from './types'

// "updated by #x" for an updates link and "contradicted by #x" for a
// contradicts link (or a row hidden before v5), in the pack and in MCP lines.
let temp: TempStore
let session: number
beforeEach(() => {
  temp = openTempStore('sam-labels-')
  session = seedSession(temp.store, 'claude-code', 's1')
})
afterEach(() => temp.cleanup())

function seed(title: string, evidence: string, at: number): number {
  const result = temp.store.db.query(
    `INSERT INTO observations (project_key, session_id, host, type, title, evidence, content_hash, occurred_at, created_at)
     VALUES (?, ?, 'claude-code', 'discovery', ?, ?, ?, ?, ?)`,
  ).run(PROJECT, session, title, evidence, `hash-${title}`, at, at)
  return Number(result.lastInsertRowid)
}

/** Three pairs: an update, a contradiction, and a row hidden by hand the way pre-v5 data was. */
function seedPairs(): Record<'stale' | 'fresh' | 'wrong' | 'right' | 'legacy' | 'manual', number> {
  const ids = {
    stale: seed('Suite has 48 passing gadget tests', 'tool-verified', T0),
    fresh: seed('Suite has 52 passing gadget tests', 'tool-verified', T0 + 10),
    wrong: seed('Gadget route returns nothing', 'interpretation', T0 + 1),
    right: seed('Gadget route returns three matches', 'tool-verified', T0 + 11),
    legacy: seed('Gadget spool drains randomly', 'interpretation', T0 + 2),
    manual: seed('Gadget spool drains in host order', 'tool-verified', T0 + 12),
  }
  insertLinks(temp.store.db, ids.fresh, [{ kind: 'updates', observationId: ids.stale }], T0)
  insertLinks(temp.store.db, ids.right, [{ kind: 'contradicts', observationId: ids.wrong }], T0)
  settleContradictions(temp.store.db, [ids.stale, ids.wrong])
  temp.store.db.query('UPDATE observations SET contradicted_by = ? WHERE id = ?').run(ids.manual, ids.legacy)
  return ids
}

test('the label names the link kind, and a missing kind reads as contradicted', () => {
  expect([contradictionLabel('updates'), contradictionLabel('contradicts'), contradictionLabel(null), contradictionLabel(undefined)])
    .toEqual(['updated by', 'contradicted by', 'contradicted by', 'contradicted by'])
})

test('the pack says "updated by" under an update and "contradicted by" under a contradiction or a legacy row', () => {
  const ids = seedPairs()
  const pack = rebuildPack(temp.store.db, PROJECT, 'claude-code', T0 + 60_000)!
  const line = (id: number): string | undefined => pack.body.split('\n').find((text) => text.includes(`(#${id})`))
  expect(line(ids.stale)).toContain(`(updated by #${ids.fresh})`)
  expect(line(ids.wrong)).toContain(`(contradicted by #${ids.right})`)
  expect(line(ids.legacy)).toContain(`(contradicted by #${ids.manual})`)
  expect(line(ids.fresh)).not.toContain(' by #')
  expect(pack.tokenCount).toBe(Math.ceil(pack.body.length / 4))
})

test('MCP index lines carry the same labels', () => {
  const ids = seedPairs()
  const reader = openMemoryReader(temp.dataDir)!
  try {
    const rows = reader.search(ftsMatch(['gadget'], 'any'), { project: PROJECT, type: null, host: null, evidence: null, limit: 20, offset: 0 })
    const line = (id: number): string => indexLine(rows.find((row) => row.id === id)!, T0 + 60_000)
    expect(rows.find((row) => row.id === ids.stale)?.contradictionKind).toBe('updates')
    expect(line(ids.stale)).toEndWith(`(updated by #${ids.fresh})`)
    expect(line(ids.wrong)).toEndWith(`(contradicted by #${ids.right})`)
    expect(line(ids.legacy)).toEndWith(`(contradicted by #${ids.manual})`)
    expect(line(ids.fresh)).not.toContain(' by #')
  } finally {
    reader.close()
  }
})

test('the MCP reader still opens a v4 store that has no links table, reading the kind as null', () => {
  const dataDir = join(temp.root, 'v4')
  mkdirSync(dataDir, { recursive: true })
  const v4 = openTestDatabase(join(dataDir, 'memory.db'))
  for (const sql of MIGRATIONS.slice(0, 4)) v4.run(sql)
  v4.run('PRAGMA user_version = 4')
  v4.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('p', 'path', 'p', 1)")
  v4.run("INSERT INTO observations (project_key, host, type, title, evidence, content_hash, occurred_at, created_at) VALUES ('p', 'h', 'discovery', 'gadget a', 'tool-verified', 'a', 1, 1)")
  v4.run("INSERT INTO observations (project_key, host, type, title, evidence, content_hash, occurred_at, created_at, contradicted_by) VALUES ('p', 'h', 'discovery', 'gadget b', 'interpretation', 'b', 0, 0, 1)")
  v4.close()
  const reader = openMemoryReader(dataDir)!
  try {
    const rows = reader.search(ftsMatch(['gadget'], 'any'), { project: 'p', type: null, host: null, evidence: null, limit: 5, offset: 0 })
    expect(rows.map((row) => [row.id, row.contradictionKind])).toEqual(expect.arrayContaining([[1, null], [2, null]]))
    expect(indexLine(rows.find((row) => row.id === 2)!, 10)).toEndWith('(contradicted by #1)')
  } finally {
    reader.close()
  }
})
