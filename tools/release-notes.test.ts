import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReleaseNotesError, releaseNotes, writeReleaseNotes } from './release-notes'

const SUMS = [
  `${'a'.repeat(64)}  kinfold-darwin-arm64`,
  `${'b'.repeat(64)}  kinfold-darwin-x64`,
  `${'c'.repeat(64)}  kinfold-linux-arm64`,
  `${'d'.repeat(64)}  kinfold-linux-x64`,
  `${'e'.repeat(64)}  kinfold-windows-x64.exe`,
].join('\n')

let dir: string | undefined
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

test('release notes name the version in every install command and carry SHA256SUMS verbatim', () => {
  const notes = releaseNotes('0.1.0', `${SUMS}\n`)
  expect(notes).toContain('npx kinfold@0.1.0 install')
  expect(notes).toContain('curl -fsSL https://github.com/yahyafakhroji/kinfold/releases/download/v0.1.0/install.sh | KINFOLD_VERSION=0.1.0 sh')
  expect(notes).toContain("$env:KINFOLD_VERSION = '0.1.0'; irm https://github.com/yahyafakhroji/kinfold/releases/download/v0.1.0/install.ps1 | iex")
  expect(notes).toContain(`\`\`\`text\n${SUMS}\n\`\`\``)
  expect(notes).toContain('WSL')
  expect(notes).toContain('preview')
  expect(notes).toContain('https://github.com/yahyafakhroji/kinfold#readme')
  expect(notes).not.toContain('{{')
})

test('release notes refuse a version or checksums the installers would not accept', () => {
  expect(() => releaseNotes('0.0.0-dev', SUMS)).toThrow(ReleaseNotesError)
  expect(() => releaseNotes('1.0; rm -rf', SUMS)).toThrow(ReleaseNotesError)
  expect(() => releaseNotes('0.1.0', '')).toThrow(ReleaseNotesError)
  expect(() => releaseNotes('0.1.0', `${'a'.repeat(64)} *kinfold-linux-x64`)).toThrow(ReleaseNotesError)
})

test('writeReleaseNotes reads dist/SHA256SUMS and writes dist/RELEASE_NOTES.md', () => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-notes-'))
  writeFileSync(join(dir, 'SHA256SUMS'), `${SUMS}\n`)
  const path = writeReleaseNotes(dir, '0.1.0')
  expect(path).toBe(join(dir, 'RELEASE_NOTES.md'))
  expect(readFileSync(path, 'utf8')).toBe(releaseNotes('0.1.0', `${SUMS}\n`))
})
