import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyAction } from '../../../resources/install-plan/plan'
import { HIDDEN_WINDOW, CANNOT_RUN_EXIT, KILL_GRACE_MS, NOT_FOUND_EXIT, createCommandRunner } from '../../install/system'
import { type FakeWorld, createWorld } from './test-support'

const CHILD_ENV = { PATH: '/usr/bin:/bin' }
const SLACK_MS = 1_000
const TIMEOUT_MS = 200
const onWindows = process.platform === 'win32'

const dirs: string[] = []
let world: FakeWorld | null = null
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  await world?.cleanup()
  world = null
})

async function timed(argv: readonly string[]): Promise<{ elapsed: number; timedOut: boolean | undefined }> {
  const started = performance.now()
  const result = await createCommandRunner(CHILD_ENV)({ argv, timeoutMs: TIMEOUT_MS })
  return { elapsed: performance.now() - started, timedOut: result.timedOut }
}

test.skipIf(onWindows)('a child that ignores SIGTERM is killed after the grace period', async () => {
  const { elapsed, timedOut } = await timed(['/bin/sh', '-c', 'trap "" TERM; sleep 30'])
  expect(timedOut).toBe(true)
  expect(elapsed).toBeLessThan(TIMEOUT_MS + KILL_GRACE_MS + SLACK_MS)
}, 10_000)

test.skipIf(onWindows)('a grandchild holding stdout does not hang the runner', async () => {
  const { elapsed, timedOut } = await timed(['/bin/sh', '-c', 'sleep 30 & sleep 30'])
  expect(timedOut).toBe(true)
  expect(elapsed).toBeLessThan(TIMEOUT_MS + KILL_GRACE_MS + SLACK_MS)
}, 10_000)

test.skipIf(onWindows)('only a missing binary counts as not installed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinfold-system-'))
  dirs.push(dir)
  const run = createCommandRunner(CHILD_ENV)
  expect((await run({ argv: [join(dir, 'missing')] })).exitCode).toBe(NOT_FOUND_EXIT)
  const notExecutable = join(dir, 'claude')
  writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n')
  chmodSync(notExecutable, 0o644)
  expect((await run({ argv: [notExecutable] })).exitCode).toBe(CANNOT_RUN_EXIT)

  world = createWorld({ commandOverride: (argv) => (argv[0] === 'claude' ? { exitCode: CANNOT_RUN_EXIT, stdout: '' } : undefined) })
  const action = { kind: 'command', argv: ['claude', 'mcp', 'remove', 'kinfold'], summary: 'remove', whenMissing: 'claude not found; skipped' } as const
  await expect(applyAction(world.env, action)).rejects.toThrow('claude mcp failed (exit 126)')
  expect(world.out.some((line) => line.includes('claude not found'))).toBe(false)
})

test('every command the installer runs is started with a hidden window', async () => {
  // An automatic update has no console, and on Windows a console program started without one opens a window.
  const seen: Record<string, unknown>[] = []
  const spawn = ((argv: string[], options: Record<string, unknown>) => {
    seen.push(options)
    return Bun.spawn(argv, options as never)
  }) as unknown as typeof Bun.spawn
  const run = createCommandRunner({ PATH: process.env.PATH ?? '' }, spawn)
  const result = await run({ argv: [process.execPath, '--version'], timeoutMs: 20_000 })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  expect(seen).toHaveLength(1)
  expect(seen[0]?.windowsHide).toBe(true)
  expect(HIDDEN_WINDOW).toEqual({ windowsHide: true })
})
