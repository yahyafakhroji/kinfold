// The database key (P2-E): 32 random bytes as hex, kept by the OS. Every
// process that opens an encrypted memory.db reads it here; nothing else ever
// sees it, and no error carries it. macOS keeps it in the login Keychain as
// shared-agent-memory/db-key (docs/reference/encryption-keys.md). Linux and
// Windows stores arrive with P2-E slice E4; until then those platforms have
// no key, so new stores there stay plaintext. SAM_DB_KEYSTORE=none turns the
// store off under `bun test` only (NODE_ENV=test), so no test reads the real
// Keychain and no production environment can switch encryption off.

import { randomBytes } from 'node:crypto'
import { type CredentialProvider, DB_KEY_REF } from '../secrets/credentials'
import { isHexKey } from '../secrets/hmac-keys'
import { ITEM_NOT_FOUND_EXIT, createKeychainProvider, runSecurity } from '../secrets/keychain'
import { existsArgs } from '../secrets/keychain-writer'
import { SqliteError } from './types'

export const DB_KEYSTORE_ENV = 'SAM_DB_KEYSTORE'

export interface DbKeyStore {
  /** Where the key lives, for `sam status`. */
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

/** The store for this platform: the Keychain on macOS, none elsewhere until E4, none when SAM_DB_KEYSTORE=none. */
export function platformDbKeyStore(env: Readonly<Record<string, string | undefined>> = process.env, platform: string = process.platform): DbKeyStore {
  if (env[DB_KEYSTORE_ENV] === 'none' && env.NODE_ENV === 'test') return NO_DB_KEYS
  if (platform !== 'darwin') return NO_DB_KEYS
  return credentialDbKeyStore('keychain', createKeychainProvider(), () => {
    const result = runSecurity(existsArgs(DB_KEY_REF))
    if (result.exitCode === 0) return true
    if (result.exitCode === ITEM_NOT_FOUND_EXIT) return false
    throw new SqliteError(`keychain lookup failed (exit ${result.exitCode})`, 'SQLITE_AUTH', 23, 'no_key')
  })
}

export function newDbKey(): string {
  return randomBytes(32).toString('hex')
}
