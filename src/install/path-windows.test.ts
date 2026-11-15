import { afterEach, expect, test } from 'bun:test'
import type { CommandRequest, CommandResult } from './env'
import { changeWindowsUserPath, userPathScript } from './path-windows'
import { type FakeWorld, createWorld } from './test-support'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const DIR = "C:\\Users\\O'Brien\\.kinfold\\bin"

function windows(result: CommandResult): { w: FakeWorld; calls: CommandRequest[] } {
  world = createWorld({ platform: 'win32' })
  const calls: CommandRequest[] = []
  world.env = { ...world.env, envVars: { SystemRoot: 'C:\\Windows' }, run: async (request) => (calls.push(request), result) }
  return { w: world, calls }
}

/** The script behind -EncodedCommand. */
function scriptOf(request: CommandRequest): string {
  return Buffer.from(request.argv.at(-1) as string, 'base64').toString('utf16le')
}

test('the script reads the raw value, keeps its registry kind, and tells open programs', () => {
  const script = userPathScript('add', DIR)
  // The folder travels as base64, so no character of a home path reaches the script text.
  expect(script).toContain(`$dir = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(DIR, 'utf8').toString('base64')}'))`)
  expect(script).not.toContain("O'Brien")
  expect(script).toContain('DoNotExpandEnvironmentNames')
  expect(script).toContain('GetValueKind')
  expect(script).toContain("[Environment]::SetEnvironmentVariable('KINFOLD_PATH_NOTICE', $null, 'User')")
  // HKCU only: no admin rights, and never the machine PATH.
  expect(script).toContain('CurrentUser')
  expect(script).not.toMatch(/LocalMachine|'Machine'/)
})

test('add appends the folder, remove filters it out', () => {
  expect(userPathScript('add', DIR)).toContain('$next = @($parts) + $dir')
  expect(userPathScript('remove', DIR)).toContain('$next = @($parts | Where-Object { -not (& $same $_) })')
})

test('it runs PowerShell by its full path, with the script encoded so no quoting can break', async () => {
  const { w, calls } = windows({ exitCode: 0, stdout: 'kinfold-path:changed\r\n' })
  expect(await changeWindowsUserPath(w.env, 'add', DIR)).toBeUndefined()
  expect(calls).toHaveLength(1)
  expect(calls[0]?.argv[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(calls[0]?.argv).toContain('-EncodedCommand')
  expect(scriptOf(calls[0] as CommandRequest)).toBe(userPathScript('add', DIR))
})

test('an entry that was already there, or already gone, is said and is not a failure', async () => {
  const added = windows({ exitCode: 0, stdout: 'kinfold-path:unchanged\r\n' })
  expect(await changeWindowsUserPath(added.w.env, 'add', DIR)).toEqual({ kept: `${DIR} was already on the user PATH` })
  const removed = windows({ exitCode: 0, stdout: 'kinfold-path:unchanged\r\n' })
  expect(await changeWindowsUserPath(removed.w.env, 'remove', DIR)).toEqual({ kept: `${DIR} was not on the user PATH` })
})

test('a failed or silent PowerShell fails the step, without echoing its output', async () => {
  const failed = windows({ exitCode: 1, stdout: 'Access denied to HKCU secret-ish text' })
  await expect(changeWindowsUserPath(failed.w.env, 'add', DIR)).rejects.toThrow('the user PATH could not be changed (powershell exit 1)')
  const silent = windows({ exitCode: 0, stdout: '' })
  await expect(changeWindowsUserPath(silent.w.env, 'add', DIR)).rejects.toThrow('the user PATH could not be changed (powershell gave no answer)')
  const slow = windows({ exitCode: 143, stdout: '', timedOut: true })
  await expect(changeWindowsUserPath(slow.w.env, 'remove', DIR)).rejects.toThrow('the user PATH could not be changed (powershell timed out)')
})
