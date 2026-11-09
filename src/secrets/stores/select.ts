// Which stores this platform may use, which one install picks, and opening the
// one key-store.json recorded. A recorded store from another platform is
// refused rather than swapped, so a key is never looked for in the wrong place.

import type { PlatformInfo } from '../../platform/platform'
import type { KeyStore, KeyStoreDeps, KeyStoreKind, KeyStoreModule } from '../key-store'
import { credentialManagerModule } from './credential-manager'
import { keyFileModule } from './key-file'
import { keychainModule } from './keychain'
import { libsecretModule } from './libsecret'

type ModuleTable = Readonly<Record<KeyStoreKind, KeyStoreModule>>

export const KEY_STORE_MODULES: ModuleTable = {
  keychain: keychainModule,
  libsecret: libsecretModule,
  'key-file': keyFileModule,
  'credential-manager': credentialManagerModule,
}

const CANDIDATES: Readonly<Record<PlatformInfo['os'], readonly KeyStoreKind[]>> = {
  macos: ['keychain'],
  linux: ['libsecret', 'key-file'],
  windows: ['credential-manager'],
}

/** In order of preference; WSL is Linux here. */
export function candidateKeyStores(platform: PlatformInfo): readonly KeyStoreKind[] {
  return CANDIDATES[platform.os]
}

export function keyStoreMismatch(kind: KeyStoreKind, platform: PlatformInfo): string {
  return `the ${KEY_STORE_MODULES[kind].label} is not a key store on ${platform.os}`
}

/** Install only: the first usable candidate, else null. */
export function chooseKeyStore(deps: KeyStoreDeps, modules: ModuleTable = KEY_STORE_MODULES): KeyStoreKind | null {
  return candidateKeyStores(deps.platform).find((kind) => modules[kind].probe(deps).usable) ?? null
}

/** Throws keyStoreMismatch when `kind` is not a candidate here. */
export function openKeyStore(kind: KeyStoreKind, deps: KeyStoreDeps, modules: ModuleTable = KEY_STORE_MODULES): KeyStore {
  if (!candidateKeyStores(deps.platform).includes(kind)) throw new Error(keyStoreMismatch(kind, deps.platform))
  return modules[kind].open(deps)
}
