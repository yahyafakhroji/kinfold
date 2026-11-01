// Credentials the system itself holds, such as the OpenRouter key. They live in
// the OS keychain and are read at call time; a value goes back to the caller
// only, never into the database, settings, logs or an error message.

import { KEYCHAIN_SERVICE } from '../names'

export interface CredentialProvider {
  /** The secret for `ref`, or null when no such entry exists. Throws only on a lookup failure. */
  get(ref: string): string | null
}

export { KEYCHAIN_SERVICE }
/** The database key (P2-E): 32 random bytes as hex, read by every process that opens memory.db. */
export const DB_KEY_REF = 'db-key'
/** The new key while `kinfold rekey` runs; it replaces db-key once the store is checked. */
export const DB_KEY_NEXT_REF = 'db-key-next'

/**
 * Entries Kinfold keeps for itself. An observer setting may never name one: the
 * observer would send the value to its provider as an API key, and
 * `kinfold uninstall --remove-credentials` would delete it with the observer keys.
 */
export const SYSTEM_CREDENTIAL_REFS: readonly string[] = ['hmac-master', 'hmac-legacy', DB_KEY_REF, DB_KEY_NEXT_REF]

export function isSystemCredentialRef(ref: string): boolean {
  return SYSTEM_CREDENTIAL_REFS.includes(ref)
}

const REF_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Refs come from observer_settings, so they are checked before reaching a command line. */
export function assertCredentialRef(ref: string): void {
  if (!REF_PATTERN.test(ref)) throw new Error('credential ref must be a short lowercase name')
}

/** For platforms without a supported keychain: every lookup is a missing credential, never a fallback. */
export const NO_CREDENTIALS: CredentialProvider = { get: () => null }
