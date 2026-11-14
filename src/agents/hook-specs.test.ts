import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { hostFromArgs } from '../cli/hook'
import type { UpdateNotice } from '../context/types'
import { KNOWN_HOSTS } from '../contract/event'
import { HOOK_SPECS, hookSpecFor } from './hook-specs'

const NOTICE: UpdateNotice = { version: '1.1.0', channel: 'npx' }

describe('HOOK_SPECS', () => {
  test('has an entry for every KNOWN_HOSTS id', () => {
    expect(Object.keys(HOOK_SPECS).sort()).toEqual([...KNOWN_HOSTS].sort())
  })

  test('hookSpecFor returns the table entry', () => {
    expect(hookSpecFor('codex')).toBe(HOOK_SPECS.codex)
    expect(hookSpecFor('zed')).toBeNull()
  })

  test('the three existing specs render the same lines as before', () => {
    const lines = (['claude-code', 'codex', 'cursor'] as const).map((id) => {
      const spec = hookSpecFor(id)
      return { id, session: spec?.sessionContext('x'), prompt: spec?.promptContext?.('x') ?? null }
    })
    expect(lines).toEqual([
      { id: 'claude-code', session: '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"x"}}', prompt: '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"x"}}' },
      { id: 'codex', session: '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"x"}}', prompt: '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"x"}}' },
      { id: 'cursor', session: '{"additional_context":"x"}', prompt: null },
    ])
    expect(hookSpecFor('claude-code')?.sessionContextWithNotice('x', NOTICE)).toContain('systemMessage')
  })
})

describe('hostFromArgs', () => {
  test('rejects an agent whose spec is null', () => {
    expect(hookSpecFor('zed')).toBeNull()
    expect(hostFromArgs(['--host', 'zed'])).toBeNull()
    expect(hostFromArgs(['--host=nonsense'])).toBeNull()
    expect(hostFromArgs([])).toBe('claude-code')
  })
})

// Runtime imports only: static `from`, side-effect, re-export and string-literal dynamic imports. `import type` / `export type` are erased, so they don't count.
const STATIC = /^\s*(?:import|export)\s+(type\s+)?[^;'"]*?from\s+['"]([^'"]+)['"]/gm
const SIDE_EFFECT = /^\s*import\s+['"]([^'"]+)['"]/gm
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

function runtimeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const specs = [...text.matchAll(STATIC)].filter((m) => m[1] === undefined).map((m) => m[2] as string)
  for (const m of text.matchAll(SIDE_EFFECT)) specs.push(m[1] as string)
  for (const m of text.matchAll(DYNAMIC)) specs.push(m[1] as string)
  return specs
}

function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return resolve(base)
}

/** Every file reachable from `entry` through relative runtime imports, plus relative targets that don't resolve to a file. */
function reachableFiles(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    if (!existsSync(file) || !statSync(file).isFile()) continue
    for (const spec of runtimeImports(file)) {
      const target = resolveLocal(file, spec)
      if (target !== null) queue.push(target)
    }
  }
  return seen
}

/** By path.relative, since the walker's paths carry the host's separator (\ on Windows), so a prefix test on `${dir}/` would match nothing there. */
const underDir = (file: string, dir: string): boolean => {
  const rel = relative(dir, file)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

describe('the hook import boundary', () => {
  test('src/cli/hook.ts reaches nothing under src/install', () => {
    const entry = resolve(import.meta.dir, '../cli/hook.ts')
    const reached = reachableFiles(entry)
    expect(reached.size).toBeGreaterThan(5)
    expect([...reached].filter((file) => underDir(file, resolve(import.meta.dir, '../install')))).toEqual([])
  })

  test('the walker catches an install import two hops down, in every import form', () => {
    const root = mkdtempSync(join(tmpdir(), 'kinfold-walk-'))
    try {
      mkdirSync(join(root, 'cli'))
      mkdirSync(join(root, 'mid'))
      mkdirSync(join(root, 'install'))
      writeFileSync(join(root, 'install/bad.ts'), 'export const bad = 1\n')
      writeFileSync(join(root, 'cli/entry.ts'), "import { a } from '../mid/a'\nimport type { T } from '../install/bad'\nexport const x = a\n")
      const cases: Record<string, string> = {
        static: "import { bad } from '../install/bad'\nexport const a = bad\n",
        sideEffect: "import '../install/bad'\nexport const a = 1\n",
        reexport: "export { bad as a } from '../install/bad'\n",
        dynamic: "export const a = () => import('../install/bad')\n",
      }
      for (const [name, body] of Object.entries(cases)) {
        writeFileSync(join(root, 'mid/a.ts'), body)
        const hit = [...reachableFiles(join(root, 'cli/entry.ts'))].filter((f) => underDir(f, join(root, 'install')))
        expect({ name, hit }).toEqual({ name, hit: [join(root, 'install/bad.ts')] })
      }
      writeFileSync(join(root, 'mid/a.ts'), "import type { bad } from '../install/bad'\nexport const a = 1\n")
      expect([...reachableFiles(join(root, 'cli/entry.ts'))].filter((f) => underDir(f, join(root, 'install')))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
