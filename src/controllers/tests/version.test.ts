import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runKinfold } from './cli/kinfold'
import { startDaemon } from './daemon/daemon'
import { type FakeWorld, createWorld } from './install/test-support'
import { VERSION } from './version'

let world: FakeWorld | null = null
let root: string | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
  if (root !== null) rmSync(root, { recursive: true, force: true })
  root = null
})

async function healthVersion(version?: string): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'sam-version-'))
  const daemon = startDaemon({ dataDir: join(root, 'data'), port: 0, fallbackDrainMs: 60_000, log: () => {}, ...(version !== undefined ? { version } : {}) })
  try {
    const body = (await (await fetch(`http://127.0.0.1:${daemon.port}/health`)).json()) as { version: string }
    return body.version
  } finally {
    await daemon.stop()
  }
}

test('a checkout reports the development version while package.json carries the released one', () => {
  // changesets writes the release version into package.json; only a release build stamps it into the program.
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as { version: string }
  expect(VERSION).toBe('0.0.0-dev')
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  expect(pkg.version).not.toBe(VERSION)
})

test('health and --version agree', async () => {
  world = createWorld()
  expect(await runKinfold(['--version'], world.env)).toBe(0)
  expect(world.out).toEqual([await healthVersion()])
})

test('a daemon reports the version it is given, so a release build can be tested', async () => {
  expect(await healthVersion('1.2.3')).toBe('1.2.3')
})
