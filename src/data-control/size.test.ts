import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeDataSettings } from '../store/data-settings-store'
import { type Fixture, seedFixture } from './test-support'
import { sizeReport } from './size'

let fx: Fixture
beforeEach(() => {
  fx = seedFixture('sam-size-')
})
afterEach(() => fx.temp.cleanup())

test('the report has file sizes, bytes by table and by project, and the warning state', () => {
  const report = sizeReport(fx.temp.store.db, fx.temp.store.path)
  expect(report.source).toBe('dbstat')
  expect(Object.keys(report).sort()).toEqual(['files', 'freeBytes', 'freelistPages', 'overWarn', 'pageCount', 'pageSize', 'projects', 'source', 'tables', 'totalBytes', 'warnBytes'])
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
