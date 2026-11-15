import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { posixOnly } from '../../test/platform-guards'
import { newShellArgv, posixLeftovers, windowsLeftoversScript, windowsNewShellScript } from './command'

let home: string | null = null
afterEach(() => {
  if (home !== null) rmSync(home, { recursive: true, force: true })
  home = null
})

function tempHome(): string {
  home = mkdtempSync(join(tmpdir(), 'kinfold-smoke-command-'))
  return home
}

describe('a new shell', () => {
  test('starts from an empty environment as a login, interactive shell, so only the startup files can put kinfold on PATH', () => {
    expect(newShellArgv('/bin/zsh', '/Users/smoke')).toEqual(['/usr/bin/env', '-i', 'HOME=/Users/smoke', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'TERM=dumb', '/bin/zsh', '-lic', 'kinfold --version'])
  })

  test('on Windows the PATH is rebuilt from the registry, which is what a terminal opened later reads', () => {
    const script = windowsNewShellScript()
    expect(script).toContain("[Environment]::GetEnvironmentVariable('Path', 'Machine')")
    expect(script).toContain("[Environment]::GetEnvironmentVariable('Path', 'User')")
    expect(script).toContain('kinfold --version')
    expect(windowsLeftoversScript()).toContain("[Environment]::GetEnvironmentVariable('Path', 'User')")
  })
})

describe('what uninstall must not leave', () => {
  posixOnly('POSIX paths')('names a link and a block that are still there', () => {
    const dir = tempHome()
    mkdirSync(join(dir, '.local', 'bin'), { recursive: true })
    symlinkSync('/gone/kinfold', join(dir, '.local', 'bin', 'kinfold'))
    writeFileSync(join(dir, '.zshrc'), 'export A=1\n# >>> kinfold >>>\n# <<< kinfold <<<\n')
    writeFileSync(join(dir, '.bashrc'), 'export A=1\n')
    expect(posixLeftovers(dir)).toEqual([`${join(dir, '.local', 'bin', 'kinfold')} is still there`, `${join(dir, '.zshrc')} still holds the kinfold PATH block`])
  })

  test('is empty for a clean home', () => {
    const dir = tempHome()
    writeFileSync(join(dir, '.zshrc'), 'export A=1\n')
    expect(posixLeftovers(dir)).toEqual([])
  })
})
