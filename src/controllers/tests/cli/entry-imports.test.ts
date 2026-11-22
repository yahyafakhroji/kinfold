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

const CLACK_ADAPTER = join(ROOT, 'src', 'install', 'prompt', 'clack.ts')
/** What agents and the service start. Their output is a protocol or data, and a hook is paid for on every prompt. */
const SERVICE_ENTRIES = ['src/cli/hook.ts', 'src/mcp/server.ts', 'src/daemon/main.ts', 'src/observer/once.ts']

interface FileImports {
  /** Relative imports resolved to files, static and import() alike. */
  files: string[]
  /** The subset reached by a static import. */
  staticFiles: string[]
  packages: string[]
}

function importsOf(file: string): FileImports {
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const found = transpiler.scanImports(readFileSync(file, 'utf8'))
  const relativeOnes = found.filter((entry) => entry.path.startsWith('.'))
  const resolved = (entries: typeof found): string[] => entries.flatMap((entry) => resolveRelative(file, entry.path) ?? [])
  return {
    files: resolved(relativeOnes),
    staticFiles: resolved(relativeOnes.filter((entry) => entry.kind !== 'dynamic-import')),
    packages: found.filter((entry) => !entry.path.startsWith('.')).map((entry) => entry.path),
  }
}

/** Every source file an entry can load, through static imports and import() alike. */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [join(ROOT, entry)]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    queue.push(...importsOf(file).files)
  }
  return [...seen]
}

const isClack = (specifier: string): boolean => specifier.startsWith('@clack/')

describe('@clack/prompts', () => {
  for (const entry of SERVICE_ENTRIES) {
    test(`${entry} cannot load it`, () => {
      const reached = reachableFrom(entry)
      expect(reached.length).toBeGreaterThan(1)
      expect(reached.filter((file) => importsOf(file).packages.some(isClack)).map((file) => relative(ROOT, file))).toEqual([])
      expect(reached).not.toContain(CLACK_ADAPTER)
    })
  }

  test('only the clack adapter imports it', () => {
    const importers = SCANNED.flatMap((dir) => sourceFiles(join(ROOT, dir))).filter((file) => importsOf(file).packages.some(isClack))
    expect(importers.map((file) => relative(ROOT, file))).toEqual([relative(ROOT, CLACK_ADAPTER)])
  })

  test('the adapter is loaded with import() only, so a command that draws nothing never pays for it', () => {
    const staticImporters = SCANNED.flatMap((dir) => sourceFiles(join(ROOT, dir))).filter((file) => importsOf(file).staticFiles.includes(CLACK_ADAPTER))
    expect(staticImporters.map((file) => relative(ROOT, file))).toEqual([])
  })
})

describe('the hook', () => {
  test('reaches no installer module: it runs on every prompt and pays only for itself', () => {
    const installer = join(ROOT, 'src', 'install')
    expect(reachableFrom('src/cli/hook.ts').filter((file) => file.startsWith(installer)).map((file) => relative(ROOT, file))).toEqual([])
  })
})

describe('the program entry', () => {
  test('no source file imports src/cli/kinfold.ts', () => {
    expect(entryImporters()).toEqual([])
  })
})
