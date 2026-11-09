// The compiled program's entry ends in a top-level `await main()`. A module
// that imports it back while main runs makes a compiled Bun program spin
// forever at full CPU before printing anything, while the same code run from
// source works. So nothing but tests may import the entry.

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const ENTRY = join(ROOT, 'src', 'cli', 'kinfold.ts')
const SCANNED = ['src', 'tools']

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

/** The file a relative specifier names, trying the extensions Bun resolves. */
function resolveRelative(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts'), base.replace(/\.js$/, '.ts')]) {
    if (candidate.endsWith('.ts') && existsSync(candidate)) return candidate
  }
  return null
}

/** Every non-test source file that imports the entry, statically or with import(). */
function entryImporters(): string[] {
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const importers: string[] = []
  for (const dir of SCANNED) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      if (file === ENTRY) continue
      const imports = transpiler.scanImports(readFileSync(file, 'utf8'))
      if (imports.some((found) => found.path.startsWith('.') && resolveRelative(file, found.path) === ENTRY)) {
        importers.push(relative(ROOT, file))
      }
    }
  }
  return importers.sort()
}

describe('the program entry', () => {
  test('no source file imports src/cli/kinfold.ts', () => {
    expect(entryImporters()).toEqual([])
  })
})
