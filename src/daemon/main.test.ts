import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
import { daemonSecrets } from './main'

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
