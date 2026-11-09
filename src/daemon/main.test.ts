import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformInfo } from '../platform/platform'
import { readMaster } from '../secrets/hmac-keys'
import type { KeyStoreDeps } from '../secrets/key-store'
import { KEY_STORE_FILE, recordUnreadableMessage } from '../secrets/key-store-record'
import type { SecurityInvocation } from '../secrets/stores/keychain'
import { openStoreFile } from '../sqlite/open'
import { SqliteError } from '../sqlite/types'
import { loadMarkerKey } from '../store/hmac-key'
import { envName } from '../env-names'
import { daemonSecrets, runDaemon } from './main'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-daemon-secrets-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const MACOS: PlatformInfo = { os: 'macos', wsl: false, node: 'darwin' }

/** A Keychain whose every `security` call fails, as a locked or broken one does. */
function brokenKeychain(calls: SecurityInvocation[]): KeyStoreDeps {
  return {
    platform: MACOS,
    homeDir: dir,
    dataDir: dir,
    envVars: {},
    security: (invocation) => {
      calls.push(invocation)
      return { exitCode: 51, stdout: '' }
    },
  }
}

test('the daemon refuses an unreadable record before it opens memory.db', () => {
  const path = join(dir, KEY_STORE_FILE)
  writeFileSync(path, '{"store":"keychain",')
  const calls: SecurityInvocation[] = []
  expect(() => daemonSecrets(dir, brokenKeychain(calls))).toThrow(recordUnreadableMessage(path))
  expect(calls).toEqual([])
  expect(existsSync(join(dir, 'memory.db'))).toBe(false)
  expect(existsSync(join(dir, 'hmac.key'))).toBe(false)
  expect(existsSync(join(dir, 'hmac.d'))).toBe(false)
})

test('a store that cannot be read never leads to a new key', () => {
  writeFileSync(join(dir, KEY_STORE_FILE), '{"store":"keychain","chosenAt":1}')
  const calls: SecurityInvocation[] = []
  const { credentials, dbKeys } = daemonSecrets(dir, brokenKeychain(calls))
  const dbPath = join(dir, 'memory.db')
  let thrown: unknown
  try {
    openStoreFile(dbPath, { create: true, keys: dbKeys })
  } catch (error: unknown) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(SqliteError)
  expect((thrown as SqliteError).kind).toBe('no_key')
  expect(existsSync(dbPath)).toBe(false)
  expect(readMaster(credentials)).toEqual({ state: 'unavailable', errorClass: 'exit_51' })
  loadMarkerKey(dir, Date.now(), { mayCreateLegacy: false })
  expect(existsSync(join(dir, 'hmac.key'))).toBe(false)
  expect(readdirSync(dir)).toEqual([KEY_STORE_FILE])
  // Only reads reached the store: nothing tried to add an entry.
  expect(calls.some((call) => call.args[0] === '-i')).toBe(false)
})

const DAEMON_ENV = [envName('DATA_DIR'), envName('PORT'), 'HOME'] as const

/** Runs runDaemon in this process on a free port with a temp data folder, until `stop` sends the signal. */
async function inProcessDaemon(argv: readonly string[]): Promise<{ dataDir: string; stop: (signal: NodeJS.Signals) => Promise<void> }> {
  const saved = DAEMON_ENV.map((name) => [name, process.env[name]] as const)
  const umask = process.umask()
  const dataDir = join(dir, 'data')
  process.env[envName('DATA_DIR')] = dataDir
  process.env[envName('PORT')] = '0'
  process.env.HOME = dir
  const running = runDaemon(argv)
  const info = join(dataDir, 'daemon.json')
  for (let waited = 0; !existsSync(info); waited += 20) {
    if (waited > 10_000) throw new Error('daemon.json never appeared')
    await Bun.sleep(20)
  }
  return {
    dataDir,
    stop: async (signal) => {
      process.emit(signal)
      await running
      process.umask(umask)
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    },
  }
}

test('a log file gets every log line at 0600', async () => {
  const logFile = join(dir, 'daemon.log')
  const daemon = await inProcessDaemon(['--log-file', logFile])
  try {
    expect(statSync(logFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(logFile, 'utf8')).toMatch(/listening on 127\.0\.0\.1:\d+ /)
  } finally {
    await daemon.stop('SIGTERM')
  }
  expect(readFileSync(logFile, 'utf8')).toContain('SIGTERM, shutting down')
})

test('SIGHUP stops the daemon cleanly', async () => {
  const before = process.listenerCount('SIGHUP')
  const daemon = await inProcessDaemon([])
  expect(process.listenerCount('SIGHUP')).toBe(before + 1)
  await daemon.stop('SIGHUP')
  expect(existsSync(join(daemon.dataDir, 'daemon.json'))).toBe(false)
  expect(process.listenerCount('SIGHUP')).toBe(before)
})
