// Writes the GitHub Release notes from scripts/release-notes.md:
// `bun tools/release-notes.ts <distDir> <version>` reads <distDir>/SHA256SUMS
// and writes <distDir>/RELEASE_NOTES.md.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEVELOPMENT_VERSION } from '../src/install/self-install'

export class ReleaseNotesError extends Error {
  override name = 'ReleaseNotesError'
}

const TEMPLATE = join(import.meta.dir, '..', 'scripts', 'release-notes.md')
/** The version characters install.sh and install.ps1 accept, since the notes put it in their commands. */
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/
/** The one line format the installers read: 64 lowercase hex, two spaces, the asset name. */
const SUMS_LINE = /^[0-9a-f]{64} {2}kinfold-[\w.-]+$/

export function releaseNotes(version: string, sums: string, template = readFileSync(TEMPLATE, 'utf8')): string {
  if (!VERSION_PATTERN.test(version)) throw new ReleaseNotesError(`${version} is not a version; use letters, digits, dots, plus and hyphen`)
  if (version === DEVELOPMENT_VERSION) throw new ReleaseNotesError(`${version} is the development version; write notes for a release version`)
  const lines = sums.trimEnd().split('\n')
  if (lines.some((line) => !SUMS_LINE.test(line))) {
    throw new ReleaseNotesError('SHA256SUMS must hold one "<sha256>  kinfold-<target>" line per program')
  }
  return template.replaceAll('{{VERSION}}', version).replaceAll('{{SHA256SUMS}}', lines.join('\n'))
}

export function writeReleaseNotes(distDir: string, version: string): string {
  const path = join(distDir, 'RELEASE_NOTES.md')
  writeFileSync(path, releaseNotes(version, readFileSync(join(distDir, 'SHA256SUMS'), 'utf8')))
  return path
}

if (import.meta.main) {
  try {
    console.log(`wrote ${writeReleaseNotes(process.argv[2] ?? '', process.argv[3] ?? '')}`)
  } catch (error: unknown) {
    if (!(error instanceof ReleaseNotesError)) throw error
    console.error(`release notes failed: ${error.message}`)
    process.exitCode = 1
  }
}
