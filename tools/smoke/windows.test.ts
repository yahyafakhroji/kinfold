// Reads the generated sources and the runner script as text, so these checks
// run on every OS and start no process.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  })
})
