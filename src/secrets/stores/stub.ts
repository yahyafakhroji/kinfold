// A store this platform will have but does not yet: never usable at install,
// and every operation refuses with one fixed message, so nothing falls back to
// a weaker place to keep a key.

import { notSupportedYet } from '../../platform/platform'
import type { KeyStore, KeyStoreKind, KeyStoreModule } from '../key-store'

const NOT_YET = 'not supported on this platform yet'

export function stubKeyStoreModule(kind: KeyStoreKind, label: string, place: string): KeyStoreModule {
  const refuse = (): never => {
    throw new Error(notSupportedYet(label))
  }
  const describe = (): string => notSupportedYet(label)
  const store: KeyStore = {
    kind,
    label,
    place,
    notes: [],
    get: refuse,
    exists: refuse,
    set: refuse,
    create: refuse,
    delete: refuse,
    describeSet: describe,
    describeDelete: describe,
    describeEntry: describe,
  }
  return {
    kind,
    label,
    probe: () => ({ usable: false, reason: NOT_YET }),
    open: () => store,
  }
}
