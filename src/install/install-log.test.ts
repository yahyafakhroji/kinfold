import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { posixOnly } from '../../test/platform-guards'
import { createInstallLog, installLogPath } from './install-log'

let dir: string | null = null
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function dataDir(withLogs: boolean): string {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-install-log-'))
  if (withLogs) mkdirSync(join(dir, 'logs'), { recursive: true })
  return dir
}

const AT = Date.UTC(2026, 10, 15, 9, 30, 0)

test('lines wait in memory until the logs folder exists, then land under a timestamped header', () => {
  const data = dataDir(false)
  const log = createInstallLog(() => AT, 'install', { dryRun: false })
  log.add('daemon: not running')
  log.flush(data)
  expect(existsSync(installLogPath(data))).toBe(false)
  mkdirSync(join(data, 'logs'))
  log.add('applying 2 actions')
  log.flush(data)
  expect(readFileSync(installLogPath(data), 'utf8')).toBe('=== kinfold install 2026-11-15T09:30:00.000Z ===\ndaemon: not running\napplying 2 actions\n')
})

test('later flushes append without a second header', () => {
  const data = dataDir(true)
  const log = createInstallLog(() => AT, 'install', { dryRun: false })
  log.add('one')
  log.flush(data)
  log.add('two')
  log.flush(data)
  log.flush(data)
  expect(readFileSync(installLogPath(data), 'utf8')).toBe('=== kinfold install 2026-11-15T09:30:00.000Z ===\none\ntwo\n')
})

test('a second run appends below the first, with its own header', () => {
  const data = dataDir(true)
  const first = createInstallLog(() => AT, 'install', { dryRun: false })
  first.add('one')
  first.flush(data)
  const second = createInstallLog(() => AT + 60_000, 'uninstall', { dryRun: false })
  second.add('two')
  second.flush(data)
  expect(readFileSync(installLogPath(data), 'utf8')).toBe('=== kinfold install 2026-11-15T09:30:00.000Z ===\none\n\n=== kinfold uninstall 2026-11-15T09:31:00.000Z ===\ntwo\n')
})

test('a dry run writes nothing', () => {
  const data = dataDir(true)
  const log = createInstallLog(() => AT, 'install', { dryRun: true })
  log.add('plan (dry run, nothing is changed): 2 actions')
  log.flush(data)
  expect(existsSync(installLogPath(data))).toBe(false)
})

test('a run that said nothing writes nothing', () => {
  const data = dataDir(true)
  createInstallLog(() => AT, 'install', { dryRun: false }).flush(data)
  expect(existsSync(installLogPath(data))).toBe(false)
})

posixOnly('file modes')('the log is readable by its owner only', () => {
  const data = dataDir(true)
  const log = createInstallLog(() => AT, 'install', { dryRun: false })
  log.add('one')
  log.flush(data)
  expect(statSync(installLogPath(data)).mode & 0o777).toBe(0o600)
})

test('a log that cannot be written never fails the install', () => {
  const data = dataDir(false)
  // A file where the folder should be: the append fails.
  mkdirSync(join(data, 'logs', 'install.log'), { recursive: true })
  const log = createInstallLog(() => AT, 'install', { dryRun: false })
  log.add('one')
  expect(() => log.flush(data)).not.toThrow()
})
