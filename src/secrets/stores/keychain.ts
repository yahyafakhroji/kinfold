// The macOS Keychain through the `security` tool, as a KeyStore.
// Reads:   security find-generic-password -s kinfold -a <ref> -w
// A read miss (exit 44) falls back to the legacy service shared-agent-memory,
// so an install that predates the rename keeps working until it is migrated.
// Writes: `security add-generic-password -w <value>` would put the value in
// argv, which `ps` shows to every user, so the command line goes to
// `security -i` on stdin instead. The value never reaches argv, an env var, a
// file, a log line or an error message: errors carry exit codes only, and
// security's own output is dropped unread. Existence checks run without -w,
// so they read item metadata and never the secret.

import { LEGACY_KEYCHAIN_SERVICE } from '../../names'
import { KEYCHAIN_SERVICE, assertCredentialRef, assertStorableValue } from '../credentials'
import type { KeyStore, KeyStoreModule } from '../key-store'

export interface SecurityResult {
  exitCode: number
  stdout: string
}

export type SecurityCommand = (args: readonly string[]) => SecurityResult

export interface SecurityInvocation {
  args: readonly string[]
  /** Sent to the child's stdin; the only place a secret may travel. */
  stdin?: string
}

export type SecurityRunner = (invocation: SecurityInvocation) => SecurityResult

/** `security` exits 44 when the item does not exist. */
export const ITEM_NOT_FOUND_EXIT = 44
export const SECURITY_BINARY = '/usr/bin/security'
/** Reads: hooks share a 10 s host budget, so a lookup stuck on a Keychain prompt must give up well inside it. */
export const LOOKUP_TIMEOUT_MS = 5_000
/** Installer writes, which run from a terminal and may wait on an unlock prompt. */
export const SECURITY_TIMEOUT_MS = 10_000

export interface SecuritySpawnOptions {
  stdin: Buffer | 'ignore'
  stdout: 'pipe'
  stderr: 'ignore'
  env: Record<string, string>
  timeout: number
}

/** Test seam for the `security` child; default Bun.spawnSync. */
export type SecuritySpawn = (cmd: string[], options: SecuritySpawnOptions) => { exitCode: number | null; stdout: Buffer }

const spawnSecurity: SecuritySpawn = (cmd, options) => Bun.spawnSync(cmd, options)

export const runSecurity: SecurityCommand = (args) => {
  const child = Bun.spawnSync([SECURITY_BINARY, ...args], {
    stdout: 'pipe',
    stderr: 'ignore',
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
    timeout: LOOKUP_TIMEOUT_MS,
  })
  return { exitCode: child.exitCode ?? -1, stdout: child.stdout.toString() }
}

/** The real `security` child: a fixed PATH and the given HOME, stderr ignored. Pass LOOKUP_TIMEOUT_MS for a runner that serves reads. */
export function createSecurityRunner(homeDir: string, timeoutMs: number = SECURITY_TIMEOUT_MS, spawn: SecuritySpawn = spawnSecurity): SecurityRunner {
  return ({ args, stdin }) => {
    const child = spawn([SECURITY_BINARY, ...args], {
      stdin: stdin !== undefined ? Buffer.from(stdin) : 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      env: { PATH: '/usr/bin:/bin', HOME: homeDir },
      timeout: timeoutMs,
    })
    return { exitCode: child.exitCode ?? -1, stdout: child.stdout.toString() }
  }
}

export function keychainArgs(ref: string, service: string = KEYCHAIN_SERVICE): string[] {
  return ['find-generic-password', '-s', service, '-a', ref, '-w']
}

/** The value under one service, null when missing or empty. Throws with the exit code only. */
export function readKeychainValue(run: SecurityCommand, ref: string, service: string): string | null {
  const result = run(keychainArgs(ref, service))
  if (result.exitCode === ITEM_NOT_FOUND_EXIT) return null
  if (result.exitCode !== 0) throw new Error(`keychain lookup failed (exit ${result.exitCode})`)
  const value = result.stdout.replace(/\r?\n$/, '')
  return value === '' ? null : value
}

/** The one line `security -i` reads from stdin. `update` false never replaces an existing entry (the add fails instead). */
export function addCommandLine(ref: string, value: string, update = true, service: string = KEYCHAIN_SERVICE): string {
  assertCredentialRef(ref)
  assertStorableValue(value)
  return `add-generic-password${update ? ' -U' : ''} -s ${service} -a ${ref} -w ${value}\n`
}

export function existsArgs(ref: string, service: string = KEYCHAIN_SERVICE): string[] {
  return ['find-generic-password', '-s', service, '-a', ref]
}

export function deleteArgs(ref: string, service: string = KEYCHAIN_SERVICE): string[] {
  return ['delete-generic-password', '-s', service, '-a', ref]
}

function presence(result: SecurityResult, action: string): boolean {
  if (result.exitCode === 0) return true
  if (result.exitCode === ITEM_NOT_FOUND_EXIT) return false
  throw new Error(`keychain ${action} failed (exit ${result.exitCode})`)
}

/** The pre-rename service (shared-agent-memory), for the migration that copies entries to kinfold and deletes these. */
export interface LegacyKeychain {
  exists(account: string): boolean
  /** The value, or null when there is none. Throws with an exit code only. */
  read(account: string): string | null
  /** True when an entry was deleted, false when there was none. */
  remove(account: string): boolean
}

export function createKeychainStore(run: SecurityRunner): KeyStore & { legacy: LegacyKeychain } {
  const command: SecurityCommand = (args) => run({ args })
  const exists = (ref: string): boolean => {
    assertCredentialRef(ref)
    return presence(run({ args: existsArgs(ref) }), 'lookup')
  }
  const legacy: LegacyKeychain = {
    exists: (ref) => {
      assertCredentialRef(ref)
      return presence(run({ args: existsArgs(ref, LEGACY_KEYCHAIN_SERVICE) }), 'lookup')
    },
    read: (ref) => {
      assertCredentialRef(ref)
      return readKeychainValue(command, ref, LEGACY_KEYCHAIN_SERVICE)
    },
    remove: (ref) => {
      assertCredentialRef(ref)
      return presence(run({ args: deleteArgs(ref, LEGACY_KEYCHAIN_SERVICE) }), 'delete')
    },
  }
  return {
    kind: 'keychain',
    label: 'keychain',
    place: 'the Keychain',
    notes: [],
    legacy,
    exists,
    get: (ref) => {
      assertCredentialRef(ref)
      return readKeychainValue(command, ref, KEYCHAIN_SERVICE) ?? readKeychainValue(command, ref, LEGACY_KEYCHAIN_SERVICE)
    },
    set: (ref, value) => {
      const result = run({ args: ['-i'], stdin: addCommandLine(ref, value) })
      if (result.exitCode !== 0) throw new Error(`keychain write failed (exit ${result.exitCode})`)
      // `security -i` can exit 0 after a failed command, so the entry itself is the proof.
      if (!exists(ref)) throw new Error('keychain write did not create the entry')
    },
    create: (ref, value) => {
      if (exists(ref)) return false
      const result = run({ args: ['-i'], stdin: addCommandLine(ref, value, false) })
      if (result.exitCode !== 0) throw new Error(`keychain write failed (exit ${result.exitCode})`)
      if (!exists(ref)) throw new Error('keychain write did not create the entry')
      return true
    },
    delete: (ref) => {
      assertCredentialRef(ref)
      return presence(run({ args: deleteArgs(ref) }), 'delete')
    },
    describeSet: (ref) => `keychain: ${SECURITY_BINARY} -i <<< "add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${ref} -w <hidden>"`,
    describeDelete: (ref) => `keychain: ${SECURITY_BINARY} delete-generic-password -s ${KEYCHAIN_SERVICE} -a ${ref}`,
    describeEntry: (ref) => `the Keychain item with service ${KEYCHAIN_SERVICE} and account ${ref}`,
  }
}

export const keychainModule: KeyStoreModule = {
  kind: 'keychain',
  label: 'keychain',
  // Never runs `security`: a locked login keychain is still the store, and a
  // probe that said otherwise would leave a new memory.db in plaintext.
  probe: () => ({ usable: true }),
  open: (deps) => createKeychainStore(deps.security),
}

/** The old-service view behind a Keychain store; null for every other kind. */
export function legacyKeychainOf(store: KeyStore): LegacyKeychain | null {
  if (store.kind !== 'keychain' || !('legacy' in store)) return null
  return (store as KeyStore & { legacy: LegacyKeychain }).legacy
}
