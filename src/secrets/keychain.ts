// The process-wide credential reader. The Keychain code lives in
// stores/keychain.ts; these names delegate there so existing callers compile.

import { readEnv } from '../env-names'
import { currentPlatform, osOf } from '../platform/platform'
import { type CredentialProvider, NO_CREDENTIALS } from './credentials'
import { credentialProviderOf } from './key-store'
import { type SecurityCommand, createKeychainStore, runSecurity } from './stores/keychain'

export { ITEM_NOT_FOUND_EXIT, type SecurityCommand, type SecurityResult, keychainArgs, readKeychainValue, runSecurity } from './stores/keychain'

export function createKeychainProvider(run: SecurityCommand = runSecurity): CredentialProvider {
  return credentialProviderOf(createKeychainStore(({ args }) => run(args)))
}

/**
 * The keychain on macOS; elsewhere every credential is missing until a libsecret
 * provider exists. KINFOLD_DB_KEYSTORE=none under bun test turns the keychain
 * off too, as it does the database key store, so a test never reads the real one.
 */
export function platformCredentialProvider(
  platform: NodeJS.Platform = currentPlatform().node,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CredentialProvider {
  if (osOf(platform) !== 'macos') return NO_CREDENTIALS
  if (readEnv(env, 'DB_KEYSTORE') === 'none' && env.NODE_ENV === 'test') return NO_CREDENTIALS
  return createKeychainProvider()
}
