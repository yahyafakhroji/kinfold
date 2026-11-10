import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { CommandRequest, CommandResult } from '../env'
import { type FakeWorld, createWorld } from '../test-support'
import {
  POWERSHELL_RELATIVE_PATH, READ_RIGHTS, TRUSTED_SIDS, WINDOWS_QUERY_TIMEOUT_MS, aclScript, otherReaders, parseAclOutput, powershellArgv, psLiteral, windowsAclAccess,
} from './windows-acl'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const USER = 'S-1-5-21-1111-2222-3333-1001'
const BASE = [
  `user\t${USER}`,
  `ace\t${USER}\tAllow\t2032127\t0\tPC\\me`,
  'ace\tS-1-5-18\tAllow\t2032127\t0\tNT AUTHORITY\\SYSTEM',
  'ace\tS-1-5-32-544\tAllow\t2032127\t0\tBUILTIN\\Administrators',
]
const READ_AND_EXECUTE = 0x200a9
const SYNCHRONIZE = 0x100000
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CURLY_QUOTES = /[\u2018\u2019\u201A\u201B]/
const PAYLOAD = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/

function decodedScript(argv: readonly string[]): string {
  const encoded = argv[argv.indexOf('-EncodedCommand') + 1] ?? ''
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

/** The path the script decodes from its base64 payload. */
function pathIn(script: string): string {
  return Buffer.from(PAYLOAD.exec(script)?.[1] ?? '', 'base64').toString('utf8')
}

/** The script with its payload blanked, so two scripts compare statement by statement. */
function template(script: string): string {
  return script.replace(PAYLOAD, "FromBase64String('')")
}

function aclWorld(answer: CommandResult): FakeWorld {
  return createWorld({
    platform: 'win32',
    commandOverride: (argv) => (argv[0] === POWERSHELL ? answer : undefined),
  })
}

async function linesFor(stdout: string): Promise<string[]> {
  await world?.cleanup()
  world = aclWorld({ exitCode: 0, stdout })
  return windowsAclAccess(world.env).statusLines(world.dataDir)
}

test('the access query takes the path as a literal, never from env', async () => {
  const tricky = 'C:\\Users\\José Ä & Co\\.kinfold'
  const argv = powershellArgv({}, aclScript(tricky))
  expect(argv.slice(0, -1)).toEqual([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
  const script = decodedScript(argv)
  expect(pathIn(script)).toBe(tricky)
  expect(script).toContain('Get-Acl -LiteralPath $path')
  expect(script).not.toContain('José')
  expect(script.indexOf('[Console]::OutputEncoding')).toBeGreaterThanOrEqual(0)
  expect(script.indexOf('[Console]::OutputEncoding')).toBeLessThan(script.indexOf('Get-Acl'))
  expect(script).not.toContain('$env:')
  expect(pathIn(decodedScript(powershellArgv({}, aclScript("C:\\it's"))))).toBe("C:\\it's")

  // The status run passes only argv and a timeout: no env reaches the command.
  const seen: CommandRequest[] = []
  world = aclWorld({ exitCode: 0, stdout: BASE.join('\r\n') })
  const run = world.env.run
  await windowsAclAccess({ ...world.env, run: async (request) => (seen.push(request), run(request)) }).statusLines(world.dataDir)
  expect(seen).toHaveLength(1)
  expect(Object.keys(seen[0]!).sort()).toEqual(['argv', 'timeoutMs'])
  expect(seen[0]!.timeoutMs).toBe(WINDOWS_QUERY_TIMEOUT_MS)
  expect(pathIn(decodedScript(seen[0]!.argv))).toBe(world.dataDir)
})

test('curly quotes in the path stay data, never code', () => {
  const plain = template(aclScript('C:\\plain'))
  const paths = [
    'C:\\Users\\O\u2019Neil\\.kinfold',
    'C:\\q\u2018a\u2019b\u201Ac\u201Bd\\.kinfold',
    'C:\\x\u2019; Write-Output pwned; \u2018\\.kinfold',
    "C:\\x'; Write-Output pwned; '\\.kinfold",
  ]
  for (const path of paths) {
    const script = decodedScript(powershellArgv({}, aclScript(path)))
    expect(pathIn(script)).toBe(path)
    // The same statements as for a plain path: nothing from the path became code.
    expect(template(script)).toBe(plain)
    expect(script).not.toContain('pwned')
    expect(CURLY_QUOTES.test(script)).toBe(false)
  }
  // psLiteral, kept for fixed text, doubles every single-quote character PowerShell honours.
  expect(psLiteral("a'b''c")).toBe("'a''b''''c'")
  expect(psLiteral('O\u2019Neil \u2018\u201A\u201B')).toBe("'O\u2019\u2019Neil \u2018\u2018\u201A\u201A\u201B\u201B'")
})

test('PowerShell is named by its full path under SystemRoot', () => {
  expect(POWERSHELL_RELATIVE_PATH).toBe('System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(powershellArgv({ envVars: { SystemRoot: 'D:\\Win\\' } }, 'x')[0]).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(powershellArgv({ envVars: {} }, 'x')[0]).toBe(POWERSHELL)
  expect(powershellArgv({ envVars: { SystemRoot: '' } }, 'x')[0]).toBe(POWERSHELL)
  expect(powershellArgv({}, 'x')[0]).toBe(POWERSHELL)
})

test('only you, SYSTEM and Administrators is ok', async () => {
  const lines = await linesFor(`\uFEFF${BASE.join('\r\n')}\r\n`)
  expect(lines).toEqual([`data dir ${world!.dataDir}: access list ok (only you, SYSTEM and Administrators can read it)`])
})

test('another account that can read is named', async () => {
  const users = `ace\tS-1-5-32-545\tAllow\t${READ_AND_EXECUTE}\t0\tBUILTIN\\Users`
  const usersInherited = `ace\tS-1-5-32-545\tAllow\t${READ_AND_EXECUTE}\t1\tBUILTIN\\Users`
  const everyone = `ace\tS-1-1-0\tAllow\t${READ_AND_EXECUTE}\t1\tEveryone`
  expect(await linesFor([...BASE, users, usersInherited, everyone].join('\n'))).toEqual([
    `warning: data dir ${world!.dataDir} can also be read by BUILTIN\\Users, Everyone; Kinfold does not change access lists. Remove them under the folder's Properties > Security`,
  ])
  const denied = `ace\tS-1-5-32-545\tDeny\t${READ_AND_EXECUTE}\t0\tBUILTIN\\Users`
  expect((await linesFor([...BASE, denied].join('\n')))[0]).toContain('access list ok')
  const syncOnly = `ace\tS-1-5-32-545\tAllow\t${SYNCHRONIZE}\t0\tBUILTIN\\Users`
  expect((await linesFor([...BASE, syncOnly].join('\n')))[0]).toContain('access list ok')
})

test('a reader is matched by SID and read right, not by name', () => {
  const parsed = parseAclOutput([...BASE, 'ace\tS-1-5-32-545\tAllow\t-2147483648\t0\tVORDEFINIERT\\Benutzer'].join('\n'))
  expect(parsed?.user).toBe(USER)
  const readers = otherReaders(parsed!.user, parsed!.entries)
  expect(readers.map((entry) => entry.name)).toEqual(['VORDEFINIERT\\Benutzer'])
  expect(readers[0]!.rights).toBe(0x8000_0000)
  expect(otherReaders(USER, [{ sid: 'S-1-3-0', name: 'CREATOR OWNER', allow: true, rights: READ_AND_EXECUTE, inheritOnly: true }])).toEqual([])
  expect(TRUSTED_SIDS).toEqual(['S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-3-4'])
  expect(READ_RIGHTS & 0x1000_0000).not.toBe(0)
})

test('a failed query says why and plans nothing', async () => {
  const cases: [CommandResult, string][] = [
    [{ exitCode: 1, stdout: '' }, 'exit 1'],
    [{ exitCode: 1, stdout: '', timedOut: true }, 'timed out'],
    [{ exitCode: 0, stdout: 'Get-Acl : something went wrong\n' }, 'unexpected output'],
  ]
  for (const [result, why] of cases) {
    await world?.cleanup()
    world = aclWorld(result)
    const access = windowsAclAccess(world.env)
    expect(await access.statusLines(world.dataDir)).toEqual([`data dir ${world.dataDir}: access list could not be read (${why})`])
    expect(access.plannedFixes(world.dataDir)).toEqual({ changes: [], symlinks: [] })
  }
  expect(parseAclOutput('')).toBeNull()
  expect(parseAclOutput(`user\t${USER}\nace\tS-1-5-18\tMaybe\t1\t0\tX`)).toBeNull()
})

test('a missing folder runs nothing', async () => {
  world = aclWorld({ exitCode: 0, stdout: BASE.join('\n') })
  const missing = join(world.root, 'nowhere')
  expect(await windowsAclAccess(world.env).statusLines(missing)).toEqual([`data dir ${missing}: missing`])
  expect(world.commands).toEqual([])
})
