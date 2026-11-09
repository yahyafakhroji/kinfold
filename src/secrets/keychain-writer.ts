// Writes and deletes our macOS Keychain entries. The Keychain code lives in
// stores/keychain.ts; these names delegate there so existing callers compile.

import { osOf } from '../platform/platform'
import { type LegacyKeychain, type SecurityRunner, createKeychainStore } from './stores/keychain'

export { assertStorableValue } from './credentials'
export { SECURITY_BINARY, type SecurityInvocation, type SecurityRunner, addCommandLine, createSecurityRunner, deleteArgs, existsArgs } from './stores/keychain'

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
  legacy: LegacyKeychain
}

export function createKeychainWriter(run: SecurityRunner): CredentialWriter {
  const store = createKeychainStore(run)
  return { exists: store.exists, put: store.set, create: store.create, remove: store.delete, legacy: store.legacy }
}

/** macOS only; elsewhere there is no supported store, and the caller must refuse rather than fall back to a file. */
export function credentialWriterFor(platform: NodeJS.Platform, run: SecurityRunner): CredentialWriter | null {
  return osOf(platform) === 'macos' ? createKeychainWriter(run) : null
}
