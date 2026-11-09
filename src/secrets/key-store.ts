// One shape for every place the OS can keep Kinfold's secrets: the macOS
// Keychain, the Secret Service keyring, a key file, Windows Credential Manager.
// Callers hold a KeyStore and never ask which one it is, so a new platform adds
// a store module without touching them.

import type { PlatformInfo } from '../platform/platform'
import { type CredentialProvider, NO_CREDENTIALS } from './credentials'
import type { SecurityRunner } from './stores/keychain'

export type KeyStoreKind = 'keychain' | 'libsecret' | 'key-file' | 'credential-manager'

export const KEY_STORE_KINDS: readonly KeyStoreKind[] = ['keychain', 'libsecret', 'key-file', 'credential-manager']

/** Synchronous: the daemon reads the master at start and hooks never wait on a store. */
export interface KeyStore {
  readonly kind: KeyStoreKind
  /** Short, for status lines: "keychain". */
  readonly label: string
  /** For sentences: "the Keychain". */
  readonly place: string
  /** The value, or null when there is no entry. Throws with a fixed message, never the value. */
  get(account: string): string | null
  /** Metadata only; the value is not read. */
  exists(account: string): boolean
  /** Creates or replaces. */
  set(account: string, value: string): void
  /** Creates only when there is no entry; true when this call created it. Never replaces. */
  create(account: string, value: string): boolean
  /** True when an entry was deleted. */
  delete(account: string): boolean
  /** Dry-run text for set and delete, with the value shown as <hidden>. */
  describeSet(account: string): string
  describeDelete(account: string): string
  /** How a person finds the entry by hand, for refusal messages. */
  describeEntry(account: string): string
  /** Lines the wizard prints under the encryption step's "on" choice; [] for the Keychain. */
  readonly notes: readonly string[]
}

export interface KeyStoreDeps {
  platform: PlatformInfo
  homeDir: string
  /** The memory folder this process serves, so a store can refuse to keep keys inside it. */
  dataDir: string
  envVars: Readonly<Record<string, string | undefined>>
  /** The macOS `security` child; other stores ignore it. */
  security: SecurityRunner
  /** The location key-store.json recorded for this store, if any (the key-file folder). */
  location?: string
}

export type KeyStoreProbe = { usable: true } | { usable: false; reason: string }

export interface KeyStoreModule {
  readonly kind: KeyStoreKind
  readonly label: string
  /** Install only. Never creates or unlocks anything. */
  probe(deps: KeyStoreDeps): KeyStoreProbe
  open(deps: KeyStoreDeps): KeyStore
  /** Install only: a location to record with the choice, so later processes with another env find the same place. Absent or null: nothing recorded. */
  location?(deps: KeyStoreDeps): string | null
}

/** Reads through a store; no store means every credential is missing, never a fallback. */
export function credentialProviderOf(store: KeyStore | null): CredentialProvider {
  if (store === null) return NO_CREDENTIALS
  return { get: (ref) => store.get(ref) }
}
