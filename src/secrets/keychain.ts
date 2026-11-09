// A credential reader over a given `security` command, for the installer.
// The Keychain code lives in stores/keychain.ts; these names delegate there so
// existing callers compile.

import type { CredentialProvider } from './credentials'
import { credentialProviderOf } from './key-store'
import { type SecurityCommand, createKeychainStore, runSecurity } from './stores/keychain'

export { ITEM_NOT_FOUND_EXIT, type SecurityCommand, type SecurityResult, keychainArgs, readKeychainValue, runSecurity } from './stores/keychain'

export function createKeychainProvider(run: SecurityCommand = runSecurity): CredentialProvider {
  return credentialProviderOf(createKeychainStore(({ args }) => run(args)))
}
