// The hook runs once per agent event under a few hundred milliseconds, and the
// plugins run inside the agent's own process. Neither may load the installer:
// it is large, and it reads and writes agent config. This walks the imports
// that survive compilation (type-only ones are erased) and fails when one of
// those entry points reaches the installer (src/controllers/install or
// src/resources/install-plan).

import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const SRC = resolve(import.meta.dir, '..', '..', '..')

/** The installer's folders under src. */
const INSTALLER = ['controllers/install/', 'resources/install-plan/']

/** A file's path under src with forward slashes on every platform, so a check such as startsWith('controllers/install/') means the same on Windows. */
const under = (file: string): string => relative(SRC, file).split(sep).join('/')

/** The relative modules a file loads at runtime: static imports and re-exports that are not type-only, and dynamic imports. */
export function runtimeImports(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/^(?:import|export)\s+(?!type\b)([^'"]*?)\s*from\s*['"](\.[^'"]+)['"]/gm)) {
    const names = /^\{([^}]*)\}$/s.exec(match[1]!.trim())
    // `import { type A, type B }` is erased like `import type`.
    if (names !== null && names[1]!.split(',').every((name) => name.trim() === '' || name.trim().startsWith('type '))) continue
    found.push(match[2]!)
  }
  for (const match of text.matchAll(/^import\s*['"](\.[^'"]+)['"]/gm)) found.push(match[1]!)
  for (const match of text.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g)) found.push(match[1]!)
  return found
}

function fileOf(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec)
  return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((path) => existsSync(path) && !path.endsWith('/')) ?? null
}

/** Every source file the entry loads, by path under src, with the chain that reached it. */
function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [under(entry)]]])
  const queue = [entry]
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const spec of runtimeImports(readFileSync(file, 'utf8'))) {
      const next = fileOf(file, spec)
      if (next === null || seen.has(next)) continue
      seen.set(next, [...seen.get(file)!, under(next)])
      queue.push(next)
    }
  }
  return seen
}

test('runtimeImports skips what the compiler erases and keeps the rest', () => {
  const text = [
    `import type { A } from './a'`,
    `import { type B, type C } from './b'`,
    `import { type D, e } from './d'`,
    `import f from './f'`,
    `export { g } from './g'`,
    `export type { H } from './h'`,
    `import './side'`,
    `const lazy = await import('./lazy')`,
    `import { join } from 'node:path'`,
  ].join('\n')
  expect(runtimeImports(text).sort()).toEqual(['./d', './f', './g', './lazy', './side'])
})

for (const entry of ['controllers/cli/hook.ts', 'plugins/plugins/opencode.ts', 'plugins/plugins/kilo.ts']) {
  test(`${entry} loads nothing from the installer`, () => {
    const files = reachable(join(SRC, entry))
    // Guards the walk itself: an entry that resolved nothing would pass for the wrong reason.
    expect(files.size).toBeGreaterThan(20)
    const installer = [...files.values()].filter((chain) => INSTALLER.some((dir) => chain.at(-1)!.startsWith(dir))).map((chain) => chain.join(' -> '))
    expect(installer).toEqual([])
  })
}

// The other direction: `kinfold install`, `status` and `uninstall` need the daemon's port and nothing else of it.
for (const entry of ['controllers/install/install.ts', 'controllers/install/status.ts', 'controllers/install/uninstall.ts']) {
  test(`${entry} does not load the daemon module`, () => {
    const files = reachable(join(SRC, entry))
    expect(files.size).toBeGreaterThan(20)
    expect([...files.values()].filter((chain) => chain.at(-1) === 'controllers/daemon/daemon.ts').map((chain) => chain.join(' -> '))).toEqual([])
  })
}

test('the leak scanner gets the second redaction pass from capture, not through the daemon\'s ingest path', () => {
  const files = reachable(join(SRC, 'resources/data-control/detect.ts'))
  expect([...files.keys()].map((file) => under(file))).toContain('resources/capture/second-pass.ts')
  expect([...files.values()].filter((chain) => chain.at(-1)!.startsWith('controllers/daemon/')).map((chain) => chain.join(' -> '))).toEqual([])
})
