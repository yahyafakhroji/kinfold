// The data dir check on Windows: reads the folder's access list with a
// read-only PowerShell query and warns when an account other than the user,
// SYSTEM or Administrators can read it. Install never changes an ACL, so it
// plans no fixes. Accounts are matched by SID and rights by number, since
// account names are localized.

import { existsSync } from 'node:fs'
import type { CommandResult, InstallEnv } from '../env'
import { windowsSystemTool } from '../windows-system-path'
import type { DataDirAccess } from './check'

export const WINDOWS_QUERY_TIMEOUT_MS = 15_000

/** Windows PowerShell 5.1, present on every supported Windows; named by full path, never by bare name. */
export const POWERSHELL_RELATIVE_PATH = 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** <SystemRoot>\...\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64 of UTF-16LE script>. */
export function powershellArgv(env: Pick<InstallEnv, 'envVars'>, script: string): string[] {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return [windowsSystemTool(env, POWERSHELL_RELATIVE_PATH), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
}

/** PowerShell ends a single-quoted string at any of these, not only at the ASCII one. */
const PS_SINGLE_QUOTES = /['‘’‚‛]/g

/** A single-quoted PowerShell literal: every single-quote character doubled. Only for fixed text; paths go through psDecodedString. */
export function psLiteral(value: string): string {
  return `'${value.replace(PS_SINGLE_QUOTES, (quote) => quote + quote)}'`
}

/** A PowerShell expression that yields `value`, carried as base64 so no character of it reaches the script text. */
export function psDecodedString(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64')
  return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}'))`
}

export interface AclEntry { sid: string; name: string; allow: boolean; rights: number; inheritOnly: boolean }

/** SYSTEM, Administrators, CREATOR OWNER, OWNER RIGHTS. */
export const TRUSTED_SIDS: readonly string[] = ['S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-3-4']

/** ReadData, GENERIC_READ, GENERIC_ALL. */
export const READ_RIGHTS = 0x0000_0001 | 0x8000_0000 | 0x1000_0000

/** Without a BOM, so the first line parses; Windows PowerShell's default code page would mangle non-ASCII names. */
const UTF8_OUTPUT = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false'

export function aclScript(path: string): string {
  return [
    UTF8_OUTPUT,
    "$ErrorActionPreference = 'Stop'",
    '$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '"user`t$user"',
    `$path = ${psDecodedString(path)}`,
    '$acl = Get-Acl -LiteralPath $path',
    'foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {',
    '  $sid = $rule.IdentityReference.Value',
    '  try { $name = $rule.IdentityReference.Translate([System.Security.Principal.NTAccount]).Value } catch { $name = $sid }',
    "  $type = if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) { 'Allow' } else { 'Deny' }",
    '  $inheritOnly = if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { 1 } else { 0 }',
    '  "ace`t$sid`t$type`t$([int]$rule.FileSystemRights)`t$inheritOnly`t$name"',
    '}',
  ].join('\n')
}

const SID = /^S-1(-\d+)+$/
const INTEGER = /^-?\d+$/

function parseAce(fields: string[]): AclEntry | null {
  const [tag, sid = '', type, rights = '', inheritOnly, ...nameParts] = fields
  if (tag !== 'ace' || !SID.test(sid) || (type !== 'Allow' && type !== 'Deny') || !INTEGER.test(rights)) return null
  if (inheritOnly !== '0' && inheritOnly !== '1') return null
  const name = nameParts.join('\t').trim()
  // PowerShell prints the rights as a signed int32, so GENERIC_READ arrives negative.
  return { sid, name: name === '' ? sid : name, allow: type === 'Allow', rights: Number(rights) >>> 0, inheritOnly: inheritOnly === '1' }
}

export function parseAclOutput(stdout: string): { user: string; entries: AclEntry[] } | null {
  const lines = stdout.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim() !== '')
  const [first, ...rest] = lines
  const [tag, user = ''] = (first ?? '').split('\t')
  if (tag !== 'user' || !SID.test(user.trim())) return null
  const entries: AclEntry[] = []
  for (const line of rest) {
    const entry = parseAce(line.split('\t'))
    if (entry === null) return null
    entries.push(entry)
  }
  return { user: user.trim(), entries }
}

/** Allow entries for anyone but the user and the trusted SIDs that grant a read right; inherit-only ones reach the files inside. */
export function otherReaders(user: string, entries: readonly AclEntry[]): AclEntry[] {
  return entries.filter((entry) => entry.allow && entry.sid !== user && !TRUSTED_SIDS.includes(entry.sid) && (entry.rights & READ_RIGHTS) !== 0)
}

function failureReason(result: CommandResult): string | null {
  if (result.timedOut === true) return 'timed out'
  if (result.exitCode !== 0) return `exit ${result.exitCode}`
  return null
}

async function aclLines(env: InstallEnv, dataDir: string): Promise<string[]> {
  const result = await env.run({ argv: powershellArgv(env, aclScript(dataDir)), timeoutMs: WINDOWS_QUERY_TIMEOUT_MS })
  const parsed = failureReason(result) === null ? parseAclOutput(result.stdout) : null
  if (parsed === null) return [`data dir ${dataDir}: access list could not be read (${failureReason(result) ?? 'unexpected output'})`]
  const readers = otherReaders(parsed.user, parsed.entries)
  if (readers.length === 0) return [`data dir ${dataDir}: access list ok (only you, SYSTEM and Administrators can read it)`]
  // One account often holds several entries (its own and an inherit-only one), so name each once.
  const names = [...new Map(readers.map((entry) => [entry.sid, entry.name])).values()]
  return [`warning: data dir ${dataDir} can also be read by ${names.join(', ')}; Kinfold does not change access lists. Remove them under the folder's Properties > Security`]
}

export function windowsAclAccess(env: InstallEnv): DataDirAccess {
  return {
    plannedFixes: () => ({ changes: [], symlinks: [] }),
    statusLines: async (dataDir) => (existsSync(dataDir) ? aclLines(env, dataDir) : [`data dir ${dataDir}: missing`]),
  }
}
