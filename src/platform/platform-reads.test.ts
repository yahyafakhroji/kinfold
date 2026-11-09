import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dir, '..')
const ROOT = join(SRC, '..')
const OWNER = 'src/platform/platform.ts'
const READS = [/process\.platform/, /\bplatform\s*[!=]==\s*'(darwin|linux|win32)'/]

test('only the platform module reads process.platform', () => {
  const hits: string[] = []
  for (const file of new Bun.Glob('**/*.ts').scanSync({ cwd: SRC })) {
    const path = relative(ROOT, join(SRC, file))
    if (path === OWNER || path.endsWith('.test.ts')) continue
    readFileSync(join(SRC, file), 'utf8').split('\n').forEach((line, index) => {
      if (READS.some((pattern) => pattern.test(line))) hits.push(`${path}:${index + 1}: ${line.trim()}`)
    })
  }
  expect(hits, `platform reads outside ${OWNER}:\n${hits.join('\n')}`).toEqual([])
})
