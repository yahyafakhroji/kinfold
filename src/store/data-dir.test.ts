import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDataDir, resolveInstallDataDir } from './data-dir'

const HOOK = join(import.meta.dir, '..', 'cli', 'hook.ts')
const FIXTURES = join(import.meta.dir, '..', '..', 'test', 'fixtures', 'claude-code')

let home: string
let current: string
let legacy: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kinfold-datadir-'))
  current = join(home, '.kinfold')
  legacy = join(home, '.shared-agent-memory')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

test('only ~/.kinfold: every process uses it', () => {
  mkdirSync(current)
  expect(resolveDataDir({}, home)).toBe(current)
  expect(resolveInstallDataDir({}, home)).toBe(current)
})

test('only ~/.shared-agent-memory: non-install processes keep using it until the migration runs', () => {
  mkdirSync(legacy)
  expect(resolveDataDir({}, home)).toBe(legacy)
})

test('only ~/.shared-agent-memory: install still targets ~/.kinfold', () => {
  mkdirSync(legacy)
  expect(resolveInstallDataDir({}, home)).toBe(current)
})

test('both dirs: ~/.kinfold wins', () => {
  mkdirSync(current)
  mkdirSync(legacy)
  expect(resolveDataDir({}, home)).toBe(current)
})

test('neither dir: ~/.kinfold, and nothing is created', () => {
  expect(resolveDataDir({}, home)).toBe(current)
  expect(existsSync(current)).toBe(false)
})

test('after the migration the old path is a symlink, so ~/.kinfold is used', () => {
  mkdirSync(current)
  symlinkSync(current, legacy)
  expect(resolveDataDir({}, home)).toBe(current)
})

test('a dangling legacy symlink is not a store to fall back to', () => {
  symlinkSync(join(home, 'gone'), legacy)
  expect(resolveDataDir({}, home)).toBe(current)
})

test('a configured data dir is used as is, with no fallback', () => {
  mkdirSync(legacy)
  expect(resolveDataDir({ KINFOLD_DATA_DIR: '/x/data' }, home)).toBe('/x/data')
  expect(resolveDataDir({ SAM_DATA_DIR: '/y/data' }, home)).toBe('/y/data')
  expect(resolveInstallDataDir({ KINFOLD_DATA_DIR: '/x/data' }, home)).toBe('/x/data')
})

test('a hook run with only the legacy dir spools there and does not create ~/.kinfold', async () => {
  mkdirSync(legacy, { mode: 0o700 })
  const child = Bun.spawn([process.execPath, HOOK], {
    stdin: new TextEncoder().encode(readFileSync(join(FIXTURES, 'post-tool-use.bash.json'), 'utf8')),
    stdout: 'pipe',
    stderr: 'pipe',
    // No KINFOLD_DATA_DIR or SAM_DATA_DIR: the hook resolves the data dir from HOME like a live one.
    // The temp dir has no daemon.json, so the hook only spools and never reaches a running daemon.
    env: { PATH: process.env.PATH ?? '', HOME: home, KINFOLD_DB_KEYSTORE: 'none' },
  })
  expect(await child.exited).toBe(0)
  expect(existsSync(current)).toBe(false)
  expect(readdirSync(join(legacy, 'spool')).filter((name) => name.endsWith('.json')).length).toBe(1)
})
