// The Windows disk check. It reads the shell's BitLockerProtection property of
// the data folder's drive, which needs no admin rights, unlike manage-bde.

import type { CommandResult } from '../env'
import { WINDOWS_QUERY_TIMEOUT_MS, powershellArgv, psLiteral } from '../access/windows-acl'
import type { DiskEncryptionCheck, DiskEncryptionState } from './check'

const OFF_ADVICE = 'Turn on BitLocker or Device encryption in Settings > Privacy & security > Device encryption'

/** 'C' for C:\..., null for a UNC path or anything without a drive letter. */
export function dataDirDrive(dataDir: string): string | null {
  const match = /^([A-Za-z]):(?:[\\/]|$)/.exec(dataDir)
  return match?.[1] === undefined ? null : match[1].toUpperCase()
}

export function bitlockerScript(drive: string): string {
  return [
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    "$ErrorActionPreference = 'Stop'",
    `$value = (New-Object -ComObject Shell.Application).NameSpace(${psLiteral(`${drive}:`)}).Self.ExtendedProperty('System.Volume.BitLockerProtection')`,
    '"$value"',
  ].join('\n')
}

export function bitlockerStateOf(result: CommandResult, drive: string): DiskEncryptionState {
  if (result.timedOut === true) return { kind: 'unknown', detail: 'could not check (timed out)' }
  if (result.exitCode !== 0) return { kind: 'unknown', detail: `could not check (powershell exit ${result.exitCode})` }
  const value = result.stdout.replace(/^\uFEFF/, '').trim()
  if (!/^\d+$/.test(value)) return { kind: 'unknown', detail: 'BitLocker state unknown' }
  const state = Number(value)
  if (state === 1) return { kind: 'on' }
  if (state === 0 || state === 2) return { kind: 'off', advice: OFF_ADVICE }
  return { kind: 'unknown', detail: `BitLocker state ${state} on ${drive}:` }
}

export const bitlockerCheck: DiskEncryptionCheck = {
  name: 'BitLocker',
  async check(env) {
    const drive = dataDirDrive(env.dataDir)
    if (drive === null) return { kind: 'cannot-check' }
    const result = await env.run({ argv: powershellArgv(env, bitlockerScript(drive)), timeoutMs: WINDOWS_QUERY_TIMEOUT_MS })
    return bitlockerStateOf(result, drive)
  },
}
