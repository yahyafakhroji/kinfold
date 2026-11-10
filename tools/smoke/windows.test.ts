// Reads the generated sources and the runner script as text, so these checks
// run on every OS and start no process.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SmokeWorld } from './platform'
import { PYWINPTY_VERSION, conptyDriverSource, observerShimSource, smokePlatform } from './windows'

const RUNNER_SCRIPT = join(import.meta.dir, '..', '..', '.github', 'smoke', 'windows.sh')
const CODE_PATTERN = '([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}'

describe('windows smoke platform', () => {
  test('the Windows steps name the task, the program and the store', () => {
    expect(smokePlatform.name).toBe('windows')
    expect(smokePlatform.programName).toBe('kinfold.exe')
    expect(smokePlatform.keyStoreLabel).toBe('Credential Manager')
    expect(smokePlatform.serviceFiles('C:\\h')).toEqual(['C:\\h\\AppData\\Local\\Kinfold\\kinfold-daemon.xml'])
  })

  test('the child environment points every profile folder at the smoke home', () => {
    expect(smokePlatform.childEnv?.('C:\\h')).toEqual({
      USERPROFILE: 'C:\\h',
      LOCALAPPDATA: 'C:\\h\\AppData\\Local',
      APPDATA: 'C:\\h\\AppData\\Roaming',
    })
  })

  test('the shim answers only the print call', () => {
    const marker = 'smokeeventabc123'
    const real = 'C:\\npm\\prefix\\claude.exe'
    const source = observerShimSource(marker, real)
    expect(source).toContain("'--print'")
    expect(source).toContain(JSON.stringify(marker))
    expect(source).toContain(JSON.stringify(real))
    expect(source).toContain('Valid event_id values:')
    expect(source).toContain('process.exit(child.exitCode')
  })

  test('the shim runs a .cmd claude through cmd.exe by its full path', () => {
    const source = observerShimSource('m', 'C:\\npm\\prefix\\claude.cmd')
    expect(source).toMatch(/\\\\System32\\\\cmd\.exe/)
    expect(source).toContain('"/c"')
    const direct = observerShimSource('m', 'C:\\npm\\prefix\\claude.exe')
    expect(direct).not.toMatch(/cmd\.exe/)
  })

  test('the drive script waits for the same prompts as the expect scripts', () => {
    const source = conptyDriverSource()
    expect(source).toContain('to confirm you saved it: ')
    expect(source).toContain('Type decrypt to go on: ')
    expect(source).toContain(CODE_PATTERN)
    expect(source).toContain('PtyProcess')
    for (const code of [2, 3, 4, 5, 6]) expect(source).toContain(`sys.exit(${code})`)
  })

  test('the drive script never prints what the program wrote', () => {
    const source = conptyDriverSource()
    expect(source).not.toMatch(/\bprint\(/)
    expect(source).not.toContain('sys.stdout.write')
  })

  test('setup pins pywinpty to the version the platform names', () => {
    const script = readFileSync(RUNNER_SCRIPT, 'utf8')
    expect(PYWINPTY_VERSION).toBe('2.0.15')
    expect(script).toContain(`pywinpty==${PYWINPTY_VERSION}`)
  })

  test('cleanup removes every entry the store can hold', () => {
    const script = readFileSync(RUNNER_SCRIPT, 'utf8')
    expect(script).toContain('KinfoldDaemon')
    for (const ref of ['db-key', 'db-key-next', 'hmac-master', 'hmac-legacy', 'openrouter']) {
      expect(script).toMatch(new RegExp(`\\b${ref}\\b`))
    }
    expect(script).toContain("cmdkey /delete:kinfold/")
    expect(script).toContain('kinfold/live-')
  })

  test('setup runs every Windows live test with its flag', () => {
    const script = readFileSync(RUNNER_SCRIPT, 'utf8')
    for (const flag of ['KINFOLD_TEST_CREDENTIAL_MANAGER=1', 'KINFOLD_TEST_WINDOWS_DISK=1', 'KINFOLD_TEST_WINDOWS_ACL=1']) {
      expect(script).toContain(flag)
    }
    for (const file of [
      './src/secrets/stores/credential-manager.live.test.ts',
      './src/install/disk/bitlocker.live.test.ts',
      './src/install/access/windows-acl.live.test.ts',
    ]) {
      expect(script).toContain(file)
      expect(existsSync(join(import.meta.dir, '..', '..', file))).toBe(true)
    }
  })

  test('status after install must show the running task and the ok access list', () => {
    const world = { dataDir: 'C:\\h\\.kinfold' } as SmokeWorld
    expect(smokePlatform.statusLines?.(world)).toEqual([
      'service (scheduled task): config present; running: yes',
      'data dir C:\\h\\.kinfold: access list ok (only you, SYSTEM and Administrators can read it)',
    ])
  })
})
