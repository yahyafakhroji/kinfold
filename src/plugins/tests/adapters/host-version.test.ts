import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOST_VERSIONS_FILE, UNPINNED_MAX_AGE_MS, isStale, normalizeVersion, parseHostVersions, recordedHostVersion, serializeHostVersions } from './host-version'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sam-host-version-'))
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

const NOW = 1_792_900_000_000

test('normalizes every --version shape to x.y.z, keeping pre-release tags', () => {
  expect(normalizeVersion('2.1.310 (Claude Code)')).toBe('2.1.310')
  expect(normalizeVersion('codex-cli 0.120.0')).toBe('0.120.0')
  expect(normalizeVersion('opencode v2.1.4')).toBe('2.1.4')
  expect(normalizeVersion('0.121.0-alpha.3')).toBe('0.121.0-alpha.3')
  expect(normalizeVersion('dev build')).toBeNull()
})

test('a pinned record is fresh while the binary keeps its mtime; an unpinned one for 30 days', () => {
  const pinned = { version: '1.0.0', recordedAt: NOW, binary: { path: '/x/codex', mtimeMs: 5 } }
  expect(isStale(pinned, NOW, () => 5)).toBe(false)
  expect(isStale(pinned, NOW, () => 6)).toBe(true)
  expect(isStale(pinned, NOW, () => null)).toBe(true)
  const unpinned = { version: '1.0.0', recordedAt: NOW, binary: null }
  expect(isStale(unpinned, NOW + UNPINNED_MAX_AGE_MS, () => null)).toBe(false)
  expect(isStale(unpinned, NOW + UNPINNED_MAX_AGE_MS + 1, () => null)).toBe(true)
})

test('reading never throws: missing, unparseable, wrong schema and bad entries all read as no version', () => {
  expect(recordedHostVersion(dataDir, 'codex', NOW)).toBeUndefined()
  writeFileSync(join(dataDir, HOST_VERSIONS_FILE), '{ nope')
  expect(recordedHostVersion(dataDir, 'codex', NOW)).toBeUndefined()
  expect(parseHostVersions({ schemaVersion: 2, hosts: { codex: { version: '1', recordedAt: 1, binary: null } } })).toEqual({})
  expect(parseHostVersions({ schemaVersion: 1, hosts: { codex: { version: 1 }, cursor: { version: '2.4.21', recordedAt: 1, binary: null } } })).toEqual({
    cursor: { version: '2.4.21', recordedAt: 1, binary: null },
  })
})

test('round-trips through the file and serves only fresh entries', () => {
  writeFileSync(join(dataDir, HOST_VERSIONS_FILE), serializeHostVersions({
    'claude-code': { version: '2.1.310', recordedAt: NOW, binary: null },
    opencode: { version: '2.1.4', recordedAt: NOW - UNPINNED_MAX_AGE_MS - 1, binary: null },
  }))
  expect(recordedHostVersion(dataDir, 'claude-code', NOW)).toBe('2.1.310')
  expect(recordedHostVersion(dataDir, 'opencode', NOW)).toBeUndefined()
})
