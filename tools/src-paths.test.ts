// Tests and modules that name a file by a path joined to their own folder
// (join(import.meta.dir, ...), new URL(..., import.meta.url), a moduleUrl
// helper) fail only when that file runs: a live test the PR run skips, or a
// worker started in the compiled program. This holds every such path that
// names a source or data file to a file that exists.

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const files = Bun.spawnSync(['git', 'ls-files', 'src', 'test', 'tools'], { cwd: ROOT }).stdout.toString().trim().split('\n').filter((file) => /\.tsx?$/.test(file))

/** Literal segments of the call, or null when one is not a plain string. */
const segments = (args: string): string[] | null => {
  const parts = args.split(',').map((part) => part.trim()).filter((part) => part !== '')
  return parts.every((part) => /^'[^']*'$/.test(part)) ? parts.map((part) => part.slice(1, -1)) : null
}

const PATTERNS = [
  /\bjoin\(import\.meta\.dir,([^()]*)\)/g,
  /\bresolve\(import\.meta\.dir,([^()]*)\)/g,
  /\bnew URL\(('[^']*'), import\.meta\.url\)/g,
  /\bmoduleUrl\(('[^']*')\)/g,
]

test('every file a module names by a path from its own folder exists', () => {
  const missing: string[] = []
  let checked = 0
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    for (const pattern of PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const parts = segments(match[1]!)
        if (parts === null) continue
        const target = join(ROOT, dirname(file), ...parts)
        // Only paths that name a file: a folder joined later, or a path a test means not to exist, is left out.
        if (!/\.(ts|tsx|json|txt|sh)$/.test(target) || /no-such/.test(target)) continue
        checked += 1
        if (!existsSync(target)) missing.push(`${file}: ${match[0]}`)
      }
    }
  }
  expect(checked).toBeGreaterThan(20)
  expect(missing).toEqual([])
})
