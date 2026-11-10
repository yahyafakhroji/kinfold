// The real Windows Credential Manager through bun:ffi. Runs only on Windows
// with KINFOLD_TEST_CREDENTIAL_MANAGER=1 (the Windows smoke runner sets it);
// every target it touches is kinfold/live-<8 hex>-..., deleted afterwards.
// Values are generated here and never printed.

import { afterAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { currentPlatform } from '../../platform/platform'
import type { KeyStoreDeps } from '../key-store'
import { credentialManagerModule, credentialTarget, loadCredApi } from './credential-manager'

const LIVE = currentPlatform().os === 'windows' && process.env.KINFOLD_TEST_CREDENTIAL_MANAGER === '1'
const PREFIX = `live-${randomBytes(4).toString('hex')}`
/** The longest value a store accepts: 512 printable characters. */
const MAX_VALUE_CHARS = 512
const touched = new Set<string>()

function ref(name: string): string {
  const full = `${PREFIX}-${name}`
  touched.add(full)
  return full
}

function deps(): KeyStoreDeps {
  const home = process.env.USERPROFILE ?? 'C:\\'
  return {
    platform: currentPlatform(),
    homeDir: home,
    dataDir: join(home, '.kinfold-live-test'),
    envVars: process.env,
    security: () => {
      throw new Error('a Credential Manager store must never run security')
    },
  }
}

/** A printable value without spaces or quotes, as the store requires. */
function value(length: number): string {
  return randomBytes(length).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, length).padEnd(length, 'k')
}

describe.skipIf(!LIVE)('Credential Manager (live)', () => {
  afterAll(() => {
    const store = credentialManagerModule.open(deps())
    for (const account of touched) store.delete(account)
    touched.clear()
  })

  test('the probe finds the store usable in this logon session', () => {
    expect(credentialManagerModule.probe(deps())).toEqual({ usable: true })
  })

  test('a missing target reads null and does not exist', () => {
    const store = credentialManagerModule.open(deps())
    const missing = ref('missing')
    expect(store.get(missing)).toBeNull()
    expect(store.exists(missing)).toBe(false)
    expect(store.delete(missing)).toBe(false)
  })

  test('create round-trips the exact bytes, up to the longest value', () => {
    const store = credentialManagerModule.open(deps())
    for (const [name, length] of [['short', 1], ['key', 64], ['longest', MAX_VALUE_CHARS]] as const) {
      const account = ref(name)
      const written = value(length)
      expect(store.create(account, written)).toBe(true)
      expect(store.exists(account)).toBe(true)
      expect(store.get(account) === written).toBe(true)
      const raw = loadCredApi().read(credentialTarget(account))
      if (!raw.ok) throw new Error(`CredReadW failed for a target this test wrote (error ${raw.error})`)
      expect(Buffer.from(raw.value).equals(Buffer.from(written, 'utf8'))).toBe(true)
      raw.value.fill(0)
    }
  })

  test('a second create returns false and keeps the first value', () => {
    const store = credentialManagerModule.open(deps())
    const account = ref('twice')
    const first = value(48)
    const second = value(48)
    expect(first === second).toBe(false)
    expect(store.create(account, first)).toBe(true)
    expect(store.create(account, second)).toBe(false)
    expect(store.get(account) === first).toBe(true)
    expect(store.delete(account)).toBe(true)
    expect(store.exists(account)).toBe(false)
  })
})
