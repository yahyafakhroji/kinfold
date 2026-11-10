// Guards for tests that check behaviour one OS family has and another lacks.
// Each guard names its reason, so `grep -rn "posixOnly('file modes')"` finds
// every test that skips for that reason. The guards only ever skip: a test
// they wrap runs unchanged wherever the reason holds.

import { test } from 'bun:test'
import { type OsName, currentPlatform } from '../src/platform/platform'

/** Behaviour every POSIX system has and Windows lacks. */
export type PosixReason =
  | 'file modes'
  | 'POSIX signals'
  | 'sh scripts'
  | 'pty via expect'
  /** Deleting or replacing a file another handle still has open. */
  | 'unlink while open'
  /** An expected path written with '/' where the code builds it with node:path. */
  | 'POSIX paths'
/** Behaviour only macOS has. */
export type MacosReason = 'launchd' | 'Keychain' | 'plist' | 'macOS paths'

/** Whether a guard of the given kind skips on `os`. */
export function skipsOn(only: 'posix' | 'macos', os: OsName): boolean {
  return only === 'posix' ? os === 'windows' : os !== 'macos'
}

/** test.skipIf for the named reason; the reason keeps every guard searchable. */
export function posixOnly(_reason: PosixReason): typeof test {
  return test.skipIf(skipsOn('posix', currentPlatform().os)) as typeof test
}

export function macosOnly(_reason: MacosReason): typeof test {
  return test.skipIf(skipsOn('macos', currentPlatform().os)) as typeof test
}

export function windowsOnly(_reason: string): typeof test {
  return test.skipIf(currentPlatform().os !== 'windows') as typeof test
}
