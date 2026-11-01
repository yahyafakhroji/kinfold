// The real sqlite-vec path: the pinned vec0.dylib loaded through sqlite3mc,
// vec_distance_cosine answering. It runs test/vec0-probe.ts in a fresh process,
// as the daemon would, and skips until SAM_TEST_VEC0 names a copy of the
// pinned vec0.dylib (the daemon's own copy is never touched by tests).

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VEC0 = process.env.SAM_TEST_VEC0
const ready = VEC0 !== undefined && VEC0 !== ''

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sam-vec0-probe-'))
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

interface ProbeOut {
  support: { ok: boolean; detail?: string; reason?: string }
  ids: Record<'east' | 'north' | 'west' | 'otherProject' | 'otherModel', number>
  inProject?: { id: number; distance: number }[]
  everywhere?: { id: number; distance: number }[]
  extra?: { id: number; distance: number }[]
}

test.skipIf(!ready)('sqlite-vec loads and ranks by cosine distance, within the project and the current model only', () => {
  // Explicit env: Bun.spawnSync hands a child the environment the process started with, not test/preload.ts's SAM_SQLITE3MC_LIB.
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, '../../test/vec0-probe.ts'), dataDir, VEC0!], { stderr: 'pipe', env: { ...process.env } })
  expect(run.exitCode).toBe(0)
  const out = JSON.parse(run.stdout.toString()) as ProbeOut
  expect(out.support).toMatchObject({ ok: true, detail: 'sqlite-vec v0.1.9' })
  expect(out.inProject!.map((hit) => hit.id)).toEqual([out.ids.east, out.ids.north, out.ids.west])
  expect(out.inProject![0]!.distance).toBeCloseTo(1 - 1 / Math.sqrt(1.01), 5)
  expect(out.inProject![2]!.distance).toBeGreaterThan(1.9)
  expect(out.everywhere!.map((hit) => hit.id)).toContain(out.ids.otherProject)
  expect(out.everywhere!.map((hit) => hit.id)).not.toContain(out.ids.otherModel)
  // A named row outside the top k gets its distance, scoped to the project; unknown ids are skipped.
  expect(out.extra!.map((hit) => hit.id)).toEqual([out.ids.west])
  expect(out.extra![0]!.distance).toBeCloseTo(out.inProject![2]!.distance, 6)
})
