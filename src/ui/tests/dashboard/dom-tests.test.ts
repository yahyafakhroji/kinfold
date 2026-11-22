// The app's component and page tests (*.dom.tsx) need a browser DOM, which
// replaces fetch, Request, Response and the timers on the global object. Each
// file runs in a `bun test` process of its own, so neither the daemon tests
// nor another DOM file ever share those globals with it.

import { expect, test } from 'bun:test'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dir, 'src')
const ROOT = join(import.meta.dir, '..', '..', '..', '..')

function domFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? domFiles(path) : name.endsWith('.dom.tsx') ? [path] : []
  })
}

const files = domFiles(SRC)

test('there are component and page tests to run', () => {
  expect(files.length).toBeGreaterThan(0)
})

for (const file of files) {
  test(`DOM: ${relative(SRC, file)}`, () => {
    const run = Bun.spawnSync([process.execPath, 'test', `./${relative(ROOT, file)}`], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: process.env })
    const output = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) process.stderr.write(output)
    expect(run.exitCode).toBe(0)
    expect(output).toMatch(/\b0 fail\b/)
  }, 120_000)
}
