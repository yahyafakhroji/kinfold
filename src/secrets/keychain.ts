// macOS Keychain lookups through the `security` tool:
//   security find-generic-password -s shared-agent-memory -a <ref> -w
// The value comes back on stdout and goes to the caller only. Errors carry the
// exit code, never stdout or stderr, so nothing here can leak the value.

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

export function keychainArgs(ref: string): string[] {
  return ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', ref, '-w']
}

export function createKeychainProvider(run: SecurityCommand = runSecurity): CredentialProvider {
  return {
    get: (ref) => {
      assertCredentialRef(ref)
      const result = run(keychainArgs(ref))
      if (result.exitCode === ITEM_NOT_FOUND_EXIT) return null
      if (result.exitCode !== 0) throw new Error(`keychain lookup failed (exit ${result.exitCode})`)
      const value = result.stdout.replace(/\r?\n$/, '')
      return value === '' ? null : value
    },
  }
}

/** The keychain on macOS; elsewhere every credential is missing until a libsecret provider exists. */
export function platformCredentialProvider(platform: NodeJS.Platform = process.platform): CredentialProvider {
  return platform === 'darwin' ? createKeychainProvider() : NO_CREDENTIALS
}
