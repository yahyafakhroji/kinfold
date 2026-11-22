// A disk check for a platform whose real one is not written yet. It runs no
// command, so status prints no disk line rather than a guess.

import type { DiskEncryptionCheck } from './check'

export function stubDiskCheck(name: string): DiskEncryptionCheck {
  return { name, check: async () => ({ kind: 'cannot-check' }) }
}
