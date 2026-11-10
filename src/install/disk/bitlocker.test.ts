import { afterEach, expect, test } from 'bun:test'
import { dbStatusLines } from '../db-encryption'
import type { CommandResult } from '../env'
import { type FakeWorld, createWorld } from '../test-support'
import { bitlockerCheck, bitlockerScript, bitlockerStateOf, dataDirDrive } from './bitlocker'
import { diskEncryptionCheckFor } from './check'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const OFF_ADVICE = 'Turn on BitLocker or Device encryption in Settings > Privacy & security > Device encryption'

function decodedScript(argv: readonly string[]): string {
  const encoded = argv[argv.indexOf('-EncodedCommand') + 1] ?? ''
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout }
}

test('BitLocker states', async () => {
  expect(bitlockerStateOf(ok('1\r\n'), 'C')).toEqual({ kind: 'on' })
  expect(bitlockerStateOf(ok('0\r\n'), 'C')).toEqual({ kind: 'off', advice: OFF_ADVICE })
  expect(bitlockerStateOf(ok('2'), 'C')).toEqual({ kind: 'off', advice: OFF_ADVICE })
  expect(bitlockerStateOf(ok('6\n'), 'D')).toEqual({ kind: 'unknown', detail: 'BitLocker state 6 on D:' })
  expect(bitlockerStateOf(ok(''), 'C')).toEqual({ kind: 'unknown', detail: 'BitLocker state unknown' })
  expect(bitlockerStateOf(ok('Protected\n'), 'C')).toEqual({ kind: 'unknown', detail: 'BitLocker state unknown' })
  expect(bitlockerStateOf({ exitCode: 1, stdout: '1' }, 'C')).toEqual({ kind: 'unknown', detail: 'could not check (powershell exit 1)' })

  world = createWorld({ platform: 'win32', commandOverride: (argv) => (argv[0] === 'powershell.exe' ? ok('1\r\n') : undefined) })
  expect(diskEncryptionCheckFor({ os: 'windows', wsl: false, node: 'win32' })).toBe(bitlockerCheck)
  const lines = await dbStatusLines({ ...world.env, dataDir: 'C:\\Users\\me\\.kinfold' })
  expect(lines).toContain('disk encryption: BitLocker on')
})

test('the drive comes from the data folder', async () => {
  expect(dataDirDrive('D:\\mem')).toBe('D')
  expect(dataDirDrive('c:/Users/me/.kinfold')).toBe('C')
  expect(dataDirDrive('\\\\server\\share\\mem')).toBeNull()
  expect(dataDirDrive('//server/share/mem')).toBeNull()
  const script = bitlockerScript('D')
  expect(script).toContain("NameSpace('D:')")
  expect(script).toContain("ExtendedProperty('System.Volume.BitLockerProtection')")

  world = createWorld({ platform: 'win32', commandOverride: (argv) => (argv[0] === 'powershell.exe' ? ok('1') : undefined) })
  expect(await bitlockerCheck.check({ ...world.env, dataDir: 'D:\\mem' })).toEqual({ kind: 'on' })
  expect(world.commands).toHaveLength(1)
  expect(decodedScript(world.commands[0]!.argv)).toContain("NameSpace('D:')")
  world.commands.length = 0
  expect(await bitlockerCheck.check({ ...world.env, dataDir: '\\\\server\\share\\mem' })).toEqual({ kind: 'cannot-check' })
  expect(world.commands).toEqual([])
})
