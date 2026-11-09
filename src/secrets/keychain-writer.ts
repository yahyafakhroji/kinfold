// Writes and deletes our macOS Keychain entries, next to the reader in
// keychain.ts. `security add-generic-password -w <value>` would put the value
// in argv, which `ps` shows to every user, so the command line goes to
// `security -i` on stdin instead. The value never reaches argv, an env var, a
// file, a log line or an error message: errors carry exit codes only, and
// security's own output is dropped unread. Existence checks run without -w,
// so they read item metadata and never the secret.

import { KEYCHAIN_SERVICE, assertCredentialRef } from './credentials'
import { LEGACY_KEYCHAIN_SERVICE } from '../names'
import { osOf } from '../platform/platform'
import { ITEM_NOT_FOUND_EXIT, type SecurityResult, readKeychainValue } from './keychain'

export const SECURITY_BINARY = '/usr/bin/security'
const SECURITY_TIMEOUT_MS = 10_000
const MAX_VALUE_CHARS = 512
/** Printable ASCII without whitespace or quote characters: one token on a `security -i` line, no escaping needed. */
const STORABLE_VALUE = /^[\x21-\x7e]+$/
const QUOTES = /["'\\]/

export interface SecurityInvocation {
  args: readonly string[]
  /** Sent to the child's stdin; the only place a secret may travel. */
  stdin?: string
}

export type SecurityRunner = (invocation: SecurityInvocation) => SecurityResult

export interface CredentialWriter {
  /** Metadata lookup (no -w). Throws on a lookup failure other than "not found". */
  exists(ref: string): boolean
  /** Creates or updates the entry; throws with an exit code only. */
  put(ref: string, value: string): void
  /** Creates the entry only if there is none, never replacing one; true when this call created it. */
  create(ref: string, value: string): boolean
  /** True when an entry was deleted, false when there was none. */
  remove(ref: string): boolean
  /** The pre-rename service (shared-agent-memory), for the migration that copies entries to kinfold and deletes these. */
  legacy: {
    exists(ref: string): boolean
    /** The value, or null when there is none. Throws with an exit code only. */
    read(ref: string): string | null
    /** True when an entry was deleted, false when there was none. */
    remove(ref: string): boolean
  }
}

/** The real `security` child: a fixed PATH and the given HOME, stderr ignored. */
export function createSecurityRunner(homeDir: string): SecurityRunner {
  return ({ args, stdin }) => {
    const child = Bun.spawnSync([SECURITY_BINARY, ...args], {
      stdin: stdin !== undefined ? Buffer.from(stdin) : 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      env: { PATH: '/usr/bin:/bin', HOME: homeDir },
      timeout: SECURITY_TIMEOUT_MS,
    })
    return { exitCode: child.exitCode ?? -1, stdout: child.stdout.toString() }
  }
}

/** Throws without quoting the value. */
export function assertStorableValue(value: string): void {
  if (value.length === 0 || value.length > MAX_VALUE_CHARS || !STORABLE_VALUE.test(value) || QUOTES.test(value)) {
    throw new Error('credential must be 1 to 512 printable characters without spaces or quotes')
  }
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

export function createKeychainWriter(run: SecurityRunner): CredentialWriter {
  const exists = (ref: string): boolean => {
    assertCredentialRef(ref)
    return presence(run({ args: existsArgs(ref) }), 'lookup')
  }
  const legacy: CredentialWriter['legacy'] = {
    exists: (ref) => {
      assertCredentialRef(ref)
      return presence(run({ args: existsArgs(ref, LEGACY_KEYCHAIN_SERVICE) }), 'lookup')
    },
    read: (ref) => {
      assertCredentialRef(ref)
      return readKeychainValue((args) => run({ args }), ref, LEGACY_KEYCHAIN_SERVICE)
    },
    remove: (ref) => {
      assertCredentialRef(ref)
      return presence(run({ args: deleteArgs(ref, LEGACY_KEYCHAIN_SERVICE) }), 'delete')
    },
  }
  return {
    exists,
    legacy,
    put: (ref, value) => {
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
    remove: (ref) => {
      assertCredentialRef(ref)
      return presence(run({ args: deleteArgs(ref) }), 'delete')
    },
  }
}

/** macOS only; elsewhere there is no supported store, and the caller must refuse rather than fall back to a file. */
export function credentialWriterFor(platform: NodeJS.Platform, run: SecurityRunner): CredentialWriter | null {
  return osOf(platform) === 'macos' ? createKeychainWriter(run) : null
}
