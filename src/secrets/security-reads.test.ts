import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dir, '..')
const KEYCHAIN_MODULE = 'secrets/stores/keychain.ts'
const MARKERS = ['/usr/bin/security', 'find-generic-password', 'add-generic-password'] as const

/**
 * Text that names a marker without running `security`: the redaction rule
 * matches that command when an agent's transcript holds it, so it must name it.
 */
const ALLOWED: Readonly<Record<string, readonly (typeof MARKERS)[number][]>> = {
  'redaction/rules.ts': ['find-generic-password'],
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

test('only the Keychain module runs security', () => {
  const offenders = sourceFiles(SRC).flatMap((path) => {
    const name = relative(SRC, path)
    if (name === KEYCHAIN_MODULE) return []
    const text = readFileSync(path, 'utf8')
    const allowed = ALLOWED[name] ?? []
    return MARKERS.filter((marker) => text.includes(marker) && !allowed.includes(marker)).map((marker) => `${name}: ${marker}`)
  })
  expect(offenders).toEqual([])
})
