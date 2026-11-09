// The file URL the smoke hands the program as KINFOLD_RELEASE_SUMS_URL. The
// workflow runs bash everywhere, and Git Bash on Windows spells $PWD as
// /d/a/..., so "file://$PWD/..." names no drive and fileURLToPath refuses it.
// pathToFileURL spells each OS's own path: file:///D:/a/... on Windows and
// file:///Users/... on macOS, the same as the old string there.
//
// Usage: bun tools/smoke-sums-url.ts <path to SHA256SUMS>

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The file URL for an absolute path, spelled as a Windows or a POSIX path. */
export function sumsUrl(absolutePath: string, windows: boolean = process.platform === 'win32'): string {
  return pathToFileURL(absolutePath, { windows }).href
}

if (import.meta.main) {
  const path = process.argv[2]
  if (path === undefined || path === '') {
    process.stderr.write('usage: bun tools/smoke-sums-url.ts <path to SHA256SUMS>\n')
    process.exit(1)
  }
  process.stdout.write(`${sumsUrl(resolve(path))}\n`)
}
