// Whether the disk under the data dir is encrypted, asked through one check per
// platform. The spool, logs and agent transcripts sit outside memory.db, so
// status reports the disk state next to the database's own.

import { type InstallEnv, platformOf } from '../env'
import type { PlatformInfo } from '../../platform/platform'
import { bitlockerCheck } from './bitlocker'
import { fileVaultCheck } from './filevault'
import { luksCheck } from './luks'

export type DiskEncryptionState =
  | { kind: 'on' }
  | { kind: 'off'; advice: string }
  | { kind: 'unknown'; detail: string }
  /** No check exists here: status prints no line. */
  | { kind: 'cannot-check' }

export interface DiskEncryptionCheck {
  /** "FileVault", "LUKS", "BitLocker". */
  readonly name: string
  check(env: InstallEnv): Promise<DiskEncryptionState>
}

export function diskEncryptionCheckFor(platform: PlatformInfo): DiskEncryptionCheck {
  switch (platform.os) {
    case 'macos': return fileVaultCheck
    case 'linux': return luksCheck
    case 'windows': return bitlockerCheck
  }
}

/** The injected env.diskCheck, else diskEncryptionCheckFor(platformOf(env)). */
export function diskCheckOf(env: InstallEnv): DiskEncryptionCheck {
  return env.diskCheck ?? diskEncryptionCheckFor(platformOf(env))
}

export function diskEncryptionLine(name: string, state: DiskEncryptionState): string | null {
  switch (state.kind) {
    case 'on': return `disk encryption: ${name} on`
    case 'off': return `warning: ${name} is off; the spool, logs and agent transcripts are unencrypted on disk. ${state.advice}`
    case 'unknown': return `disk encryption: ${state.detail}`
    case 'cannot-check': return null
  }
}
