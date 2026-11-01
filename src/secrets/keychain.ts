// macOS Keychain lookups through the `security` tool:
//   security find-generic-password -s kinfold -a <ref> -w
// A miss (exit 44) falls back to the legacy service shared-agent-memory, so an
// install that predates the rename keeps working until it is migrated.
// The value comes back on stdout and goes to the caller only. Errors carry the
// exit code, never stdout or stderr, so nothing here can leak the value.

import { LEGACY_KEYCHAIN_SERVICE } from '../names'
import { type CredentialProvider, KEYCHAIN_SERVICE, NO_CREDENTIALS, assertCredentialRef } from './credentials'

export interface SecurityResult {
  exitCode: number
  stdout: string
}

export type SecurityCommand = (args: readonly string[]) => SecurityResult

/** `security` exits 44 when the item does not exist. */
export const ITEM_NOT_FOUND_EXIT = 44
const LOOKUP_TIMEOUT_MS = 5_000

export const runSecurity: SecurityCommand = (args) => {
  const child = Bun.spawnSync(['/usr/bin/security', ...args], {
    stdout: 'pipe',
    stderr: 'ignore',
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
    timeout: LOOKUP_TIMEOUT_MS,
  })
  return { exitCode: child.exitCode ?? -1, stdout: child.stdout.toString() }
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

export function createKeychainProvider(run: SecurityCommand = runSecurity): CredentialProvider {
  return {
    get: (ref) => {
      assertCredentialRef(ref)
      return readKeychainValue(run, ref, KEYCHAIN_SERVICE) ?? readKeychainValue(run, ref, LEGACY_KEYCHAIN_SERVICE)
    },
  }
}

/** The keychain on macOS; elsewhere every credential is missing until a libsecret provider exists. */
export function platformCredentialProvider(platform: NodeJS.Platform = process.platform): CredentialProvider {
  return platform === 'darwin' ? createKeychainProvider() : NO_CREDENTIALS
}
