// The Windows half of the kinfold command: <dataDir>\bin on the user PATH.
// The value lives in HKCU\Environment, which needs no admin rights. It is
// read without expanding %NAME% parts and written back with the registry
// kind it had, so entries such as %USERPROFILE%\bin stay as the person wrote
// them. A program that is already open keeps the PATH it started with, so
// the last line tells Explorer the environment changed and terminals opened
// from then on see the new value.

import { powershellArgv, psDecodedString } from './access/windows-acl'
import type { InstallEnv } from '../../resources/install-plan/env'
import type { StepNote } from '../../resources/install-plan/plan'

export type UserPathChange = 'add' | 'remove'

/** The broadcast waits up to a second for each window that does not answer. */
const USER_PATH_TIMEOUT_MS = 60_000
const CHANGED = 'kinfold-path:changed'
const UNCHANGED = 'kinfold-path:unchanged'

export function userPathScript(change: UserPathChange, dir: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$dir = ${psDecodedString(dir)}`,
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    "if ($null -eq $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }",
    "$current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "$kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }",
    "$parts = @($current -split ';' | Where-Object { $_ -ne '' })",
    "$same = { param($entry) $entry.TrimEnd('\\').ToLowerInvariant() -eq $dir.TrimEnd('\\').ToLowerInvariant() }",
    '$has = @($parts | Where-Object { & $same $_ }).Count -gt 0',
    change === 'add' ? `if ($has) { '${UNCHANGED}'; exit 0 }` : `if (-not $has) { '${UNCHANGED}'; exit 0 }`,
    change === 'add' ? '$next = @($parts) + $dir' : '$next = @($parts | Where-Object { -not (& $same $_) })',
    "$key.SetValue('Path', ($next -join ';'), $kind)",
    '$key.Close()',
    // Setting any user variable sends WM_SETTINGCHANGE; clearing a name nothing uses changes nothing else.
    "[Environment]::SetEnvironmentVariable('KINFOLD_PATH_NOTICE', $null, 'User')",
    `'${CHANGED}'`,
  ].join('\n')
}

export async function changeWindowsUserPath(env: Pick<InstallEnv, 'run' | 'envVars'>, change: UserPathChange, dir: string): Promise<StepNote | void> {
  const result = await env.run({ argv: powershellArgv(env, userPathScript(change, dir)), timeoutMs: USER_PATH_TIMEOUT_MS })
  // The reason is fixed text: PowerShell's own output can quote the registry value.
  const failure = result.timedOut === true ? 'powershell timed out' : result.exitCode !== 0 ? `powershell exit ${result.exitCode}` : null
  if (failure !== null) throw new Error(`the user PATH could not be changed (${failure})`)
  if (result.stdout.includes(UNCHANGED)) return { kept: change === 'add' ? `${dir} was already on the user PATH` : `${dir} was not on the user PATH` }
  if (!result.stdout.includes(CHANGED)) throw new Error('the user PATH could not be changed (powershell gave no answer)')
}
