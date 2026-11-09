import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLIC_DIR } from './routes'

// A file that does not parse kills the whole page, and the DOM tests import
// pages one at a time, so parse every script here.
test('every dashboard script parses', () => {
  const transpiler = new Bun.Transpiler({ loader: 'js' })
  const scripts = readdirSync(PUBLIC_DIR).filter((name) => name.endsWith('.js'))
  expect(scripts.length).toBeGreaterThan(5)
  for (const name of scripts) {
    expect(() => transpiler.transformSync(readFileSync(join(PUBLIC_DIR, name), 'utf8')), name).not.toThrow()
  }
})
