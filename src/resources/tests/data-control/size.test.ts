import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeDataSettings } from '../../store/data-settings-store'
import { setPromptReply } from '../../store/writes'
import { type Fixture, seedFixture } from './test-support'
import { formatBytes, sizeParts, sizeReport, sizeWarning } from '../../data-control/size'

const GB = 1024 * 1024 * 1024

let fx: Fixture
beforeEach(() => {
  fx = seedFixture('sam-size-')
})
afterEach(() => fx.temp.cleanup())

test('the report has file sizes, bytes by table and by project, and the warning state', () => {
  const report = sizeReport(fx.temp.store.db, fx.temp.store.path)
  expect(report.source).toBe('dbstat')
  expect(Object.keys(report).sort()).toEqual(['files', 'freeBytes', 'freelistPages', 'overWarn', 'pageCount', 'pageSize', 'parts', 'projects', 'source', 'tables', 'totalBytes', 'warnBytes', 'warning'])
  expect(report.files.db).toBeGreaterThan(0)
  expect(report.totalBytes).toBe(report.files.db + report.files.wal)
  expect(report.pageSize * report.pageCount).toBeGreaterThan(0)
  const names = report.tables.map((table) => table.name)
  for (const name of ['events', 'observations', 'observations_fts', 'context_packs']) expect(names).toContain(name)
  expect(names.some((name) => name.startsWith('observations_fts_') || name.startsWith('events_by'))).toBe(false)
  expect(report.tables.every((table) => Number.isInteger(table.bytes) && table.bytes > 0)).toBe(true)
  expect(report.projects.map((project) => project.projectKey).sort()).toEqual([fx.projectA, fx.projectB])
  expect(report.projects.find((project) => project.projectKey === fx.projectA)).toMatchObject({ displayName: 'alpha', events: 2, observations: 2 })
  expect(report.overWarn).toBe(false)
})

test('the warning threshold comes from data_settings', () => {
  writeDataSettings(fx.temp.store.db, { warnBytes: 1 }, 0)
  expect(sizeReport(fx.temp.store.db, fx.temp.store.path)).toMatchObject({ warnBytes: 1, overWarn: true })
})

test('the parts are prompts, replies, events, observations, summaries, vectors and other, adding up to the total', () => {
  const tables = [
    { name: 'prompts', bytes: 1000 },
    { name: 'events', bytes: 300 },
    { name: 'observations', bytes: 200 },
    { name: 'observations_fts', bytes: 50 },
    { name: 'summaries', bytes: 20 },
    { name: 'observation_vectors', bytes: 400 },
    { name: 'context_packs', bytes: 30 },
  ]
  // The prompts table splits by stored text length: a quarter prompt text, three quarters replies.
  expect(sizeParts(tables, { text: 1, reply: 3 }, 2500)).toEqual([
    { name: 'prompts', bytes: 250 },
    { name: 'replies', bytes: 750 },
    { name: 'events', bytes: 300 },
    { name: 'observations', bytes: 250 },
    { name: 'summaries', bytes: 20 },
    { name: 'vectors', bytes: 400 },
    { name: 'other', bytes: 530 },
  ])
})

test('with no stored text the prompts table counts as prompts, and other never goes below zero', () => {
  const parts = sizeParts([{ name: 'prompts', bytes: 900 }], { text: 0, reply: 0 }, 500)
  expect(parts.find((part) => part.name === 'prompts')?.bytes).toBe(900)
  expect(parts.find((part) => part.name === 'replies')?.bytes).toBe(0)
  expect(parts.find((part) => part.name === 'other')?.bytes).toBe(0)
})

test('the warning names the largest part, its share and the setting that trims it', () => {
  const total = Math.round(2.1 * GB)
  const parts = sizeParts([{ name: 'prompts', bytes: Math.round(0.8 * total) }], { text: 19, reply: 61 }, total)
  expect(sizeWarning(parts, total)).toBe('replies are 61% of 2.1 GB; set prompts retention to trim them')
  const vectors = sizeParts([{ name: 'observation_vectors', bytes: 900 }, { name: 'events', bytes: 100 }], { text: 0, reply: 0 }, 1000)
  expect(sizeWarning(vectors, 1000)).toBe('vectors are 90% of 1000 B; set observations retention to trim them')
  const events = sizeParts([{ name: 'events', bytes: 600 }], { text: 0, reply: 0 }, 1000)
  expect(sizeWarning(events, 1000)).toBe('events are 60% of 1000 B; set events retention to trim them')
  const other = sizeParts([{ name: 'events', bytes: 100 }], { text: 0, reply: 0 }, 1024 * 1024)
  expect(sizeWarning(other, 1024 * 1024)).toBe('other data is 100% of 1.0 MB; no retention setting trims it')
})

test('formatBytes reaches GB', () => {
  expect(formatBytes(512)).toBe('512 B')
  expect(formatBytes(1536)).toBe('1.5 KB')
  expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  expect(formatBytes(Math.round(2.1 * GB))).toBe('2.1 GB')
})

test('the report splits replies from prompts and warns only over the threshold', () => {
  const db = fx.temp.store.db
  setPromptReply(db, fx.sessions.a1, 1, 'r'.repeat(200_000))
  const under = sizeReport(db, fx.temp.store.path)
  expect(under.parts.map((part) => part.name)).toEqual(['prompts', 'replies', 'events', 'observations', 'summaries', 'vectors', 'other'])
  expect(under.parts.reduce((sum, part) => sum + part.bytes, 0)).toBe(under.totalBytes)
  const bytesOf = (name: string): number => under.parts.find((part) => part.name === name)?.bytes ?? 0
  expect(bytesOf('replies')).toBeGreaterThan(bytesOf('prompts'))
  expect(under.warning).toBeNull()
  writeDataSettings(db, { warnBytes: 1 }, 0)
  expect(sizeReport(db, fx.temp.store.path).warning).toMatch(/^(\w+ are|other data is) \d+% of \S+ \w+; /)
})
