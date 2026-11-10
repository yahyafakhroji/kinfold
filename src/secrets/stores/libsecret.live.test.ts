// The real Secret Service through bun:ffi. Runs only on Linux with
// KINFOLD_TEST_SECRET_SERVICE=1 and an unlocked default keyring (the smoke
// scripts start one); every account it touches is live-<8 hex>-..., removed after.

import { afterAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { currentPlatform } from '../../platform/platform'
import type { KeyStore, KeyStoreDeps } from '../key-store'
import { runKeyStoreContract } from './contract'
import { type BindingLoader, type SecretServiceBinding, createLibsecretStore, ffiSecretService, probeLibsecret } from './libsecret'

const LIVE = currentPlatform().os === 'linux' && process.env.KINFOLD_TEST_SECRET_SERVICE === '1'
const PREFIX = `live-${randomBytes(4).toString('hex')}`
const touched = new Set<string>()

function liveDeps(envVars: Readonly<Record<string, string | undefined>> = process.env): KeyStoreDeps {
  return {
    platform: currentPlatform(),
    homeDir: process.env.HOME ?? '/',
    dataDir: join(process.env.HOME ?? '/', '.kinfold-live-test'),
    envVars,
    security: () => {
      throw new Error('a libsecret store must never run security')
    },
  }
}

/** The real binding, recording one line per call (account only). */
function recordingLoader(calls: string[]): BindingLoader {
  return () => {
    const real = ffiSecretService()
    const note = (operation: string, account: string) => {
      touched.add(account)
      calls.push(`${operation} ${account}`)
    }
    const binding: SecretServiceBinding = {
      defaultCollection: () => real.defaultCollection(),
      exists: (account) => (note('exists', account), real.exists(account)),
      lookup: (account) => (note('lookup', account), real.lookup(account)),
      store: (account, label, value) => (note('store', account), real.store(account, label, value)),
      create: (account, label, value) => (note('create', account), real.create(account, label, value)),
      remove: (account) => (note('remove', account), real.remove(account)),
    }
    return binding
  }
}

/** Every account the contract names is moved under this run's prefix. */
function prefixed(store: KeyStore): KeyStore {
  const at = (account: string) => `${PREFIX}-${account}`
  return {
    ...store,
    get: (account) => store.get(at(account)),
    exists: (account) => store.exists(at(account)),
    set: (account, value) => store.set(at(account), value),
    create: (account, value) => store.create(at(account), value),
    delete: (account) => store.delete(at(account)),
  }
}

function removeTouched(): void {
  const binding = ffiSecretService()
  for (const account of touched) binding.remove(account)
  touched.clear()
}

describe.skipIf(!LIVE)('libsecret (live)', () => {
  afterAll(removeTouched)

  runKeyStoreContract(
    'libsecret (live)',
    () => {
      const calls: string[] = []
      const load = recordingLoader(calls)
      return {
        store: prefixed(createLibsecretStore(liveDeps(), load)),
        observed: () => calls,
        failing: () => prefixed(createLibsecretStore(liveDeps({ ...process.env, DBUS_SESSION_BUS_ADDRESS: '' }), load)),
      }
    },
    removeTouched,
  )

  test('the live probe sees the unlocked keyring', () => {
    expect(probeLibsecret(liveDeps(), ffiSecretService)).toEqual({ usable: true })
  })

  test('a value written by one process is read by another', () => {
    const account = `${PREFIX}-handoff`
    const value = randomBytes(32).toString('hex')
    touched.add(account)
    createLibsecretStore(liveDeps(), ffiSecretService).set(account, value)
    // The expected value goes in on stdin, never argv or env; the child prints only the verdict.
    const script = [
      `import { createLibsecretStore, ffiSecretService } from ${JSON.stringify(join(import.meta.dir, 'libsecret.ts'))}`,
      `import { currentPlatform } from ${JSON.stringify(join(import.meta.dir, '..', '..', 'platform', 'platform.ts'))}`,
      'const expected = (await Bun.stdin.text()).trim()',
      `const deps = { platform: currentPlatform(), homeDir: '/', dataDir: '/', envVars: process.env, security: () => { throw new Error('no security') } }`,
      `const got = createLibsecretStore(deps, ffiSecretService).get(${JSON.stringify(account)})`,
      `console.log(got === expected ? 'match' : 'differ')`,
    ].join('\n')
    const child = Bun.spawnSync([process.execPath, '-e', script], { stdin: Buffer.from(value), stdout: 'pipe', stderr: 'pipe' })
    expect(child.stdout.toString().trim()).toBe('match')
    expect(child.exitCode).toBe(0)
  })
})
