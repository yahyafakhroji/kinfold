// The database key: 32 random bytes as hex, kept by the OS. Every
// process that opens an encrypted memory.db reads it here; nothing else ever
// sees it, and no error carries it. macOS keeps it in the login Keychain as
// kinfold/db-key, or shared-agent-memory/db-key until migrated.
// Linux and Windows stores are not built yet; until then those platforms have
// no key, so new stores there stay plaintext. KINFOLD_DB_KEYSTORE=none turns the
// store off under `bun test` only (NODE_ENV=test), so no test reads the real
// Keychain and no production environment can switch encryption off.

import { randomBytes } from 'node:crypto'
import { envName, readEnv } from '../env-names'
import { currentPlatform, osOf } from '../platform/platform'
import { type CredentialProvider, DB_KEY_REF } from '../secrets/credentials'
import { isHexKey } from '../secrets/hmac-keys'
import { type KeyStore, credentialProviderOf } from '../secrets/key-store'
import { createKeychainStore, legacyKeychainOf, runSecurity } from '../secrets/stores/keychain'
import { SqliteError } from './types'

export const DB_KEYSTORE_ENV = envName('DB_KEYSTORE')

export interface DbKeyStore {
  /** Where the key lives, for `kinfold status`. */
  name: string
  /** The key as 64 hex characters, or null when the store has none. Throws a SqliteError (kind no_key) when the lookup fails. */
  read(): string | null
  /** Whether an entry exists, from metadata only: the key is not read. Throws when the lookup fails. */
  exists(): boolean
}

export const NO_DB_KEYS: DbKeyStore = { name: 'none', read: () => null, exists: () => false }

export function credentialDbKeyStore(name: string, credentials: CredentialProvider, exists: () => boolean = () => credentials.get(DB_KEY_REF) !== null): DbKeyStore {
  return {
    name,
    exists,
    read: () => {
      let value: string | null
      try {
        value = credentials.get(DB_KEY_REF)
      } catch {
        throw new SqliteError(`the database key could not be read from the ${name}`, 'SQLITE_AUTH', 23, 'no_key')
      }
      if (value === null) return null
      if (!isHexKey(value)) throw new SqliteError(`the ${name} entry ${DB_KEY_REF} is not a 32-byte hex key`, 'SQLITE_AUTH', 23, 'no_key')
      return value
    },
  }
}

// A failed lookup is a no_key error carrying the store's own fixed message,
// which never holds the key.
function lookupOrNoKey(lookup: () => boolean): boolean {
  try {
    return lookup()
  } catch (error: unknown) {
    throw new SqliteError(error instanceof Error ? error.message : 'key store lookup failed', 'SQLITE_AUTH', 23, 'no_key')
  }
}

/** The database key in a store; an entry under the Keychain's old service counts until it is migrated. */
export function dbKeyStoreOf(store: KeyStore | null): DbKeyStore {
  if (store === null) return NO_DB_KEYS
  const legacy = legacyKeychainOf(store)
  const exists = (): boolean => lookupOrNoKey(() => store.exists(DB_KEY_REF)) || (legacy !== null && lookupOrNoKey(() => legacy.exists(DB_KEY_REF)))
  return credentialDbKeyStore(store.label, credentialProviderOf(store), exists)
}

/** The store for this platform: the Keychain on macOS, none elsewhere until E4, none when KINFOLD_DB_KEYSTORE=none. */
export function platformDbKeyStore(env: Readonly<Record<string, string | undefined>> = process.env, platform: string = currentPlatform().node): DbKeyStore {
  if (readEnv(env, 'DB_KEYSTORE') === 'none' && env.NODE_ENV === 'test') return NO_DB_KEYS
  if (osOf(platform) !== 'macos') return NO_DB_KEYS
  return dbKeyStoreOf(createKeychainStore(({ args }) => runSecurity(args)))
}

export function newDbKey(): string {
  return randomBytes(32).toString('hex')
}
