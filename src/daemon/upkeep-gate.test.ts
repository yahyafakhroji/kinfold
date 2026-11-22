// Timed vectors upkeep waits until it is decided which connection checkpoints.
// Before the checkpoint worker is on, the daemon's own connection checkpoints
// at a commit, with a flush of the store on the thread that answers requests,
// and upkeep is what writes megabytes in a burst. Here the gate is held shut
// by hand: the slice a start always runs happens, and nothing more until it opens.
// The same holds while the checkpoint worker has a checkpoint in flight.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT, T0, seedSession } from '../observer/test-support'
import { openStore } from '../store/db'
import { startActive, startBuilding } from '../store/vector-spaces'
import { encodeVector } from '../store/vector-store'
import { SWEEP_CHUNK } from '../vectors/space-manager'
import { FAKE_DIMS, fakeEmbedder } from '../vectors/test-support'
import { type RunningDaemon, startDaemon } from './daemon'

const OLD = { model: 'openrouter/old', dims: 8 }
const OBSERVATIONS = SWEEP_CHUNK * 4

let root: string
let dataDir: string
let daemon: RunningDaemon | null
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-upkeep-gate-'))
  dataDir = join(root, 'data')
  daemon = null
  // Every observation has a vector in the old space and in the new one, so the first slice switches and the rest is the sweep.
  const store = openStore(dataDir)
  const session = seedSession(store, 'claude-code', 'gate')
  const observation = store.db.prepare(`INSERT INTO observations (id, project_key, session_id, host, prompt_number, type, title, narrative, facts, files, evidence,
    source_event_ids, observer_model, content_hash, occurred_at, created_at, rules_version, scanned_version)
    VALUES ($id, $project, $session, 'claude-code', 1, 'discovery', $title, 'n', '[]', '[]', 'tool-verified', '[]', 'bench', $hash, $at, $at, 1, 0)`)
  const vector = store.db.prepare('INSERT INTO observation_vectors (observation_id, model, dims, embedding, created_at) VALUES ($id, $model, $dims, $embedding, $at)')
  store.db.transaction(() => {
    for (let id = 1; id <= OBSERVATIONS; id += 1) {
      observation.run({ id, project: PROJECT, session, title: `t${id}`, hash: `h${id}`, at: T0 + id })
      vector.run({ id, model: OLD.model, dims: OLD.dims, embedding: encodeVector(new Float32Array(OLD.dims).fill(0.01)), at: T0 })
      vector.run({ id, model: 'fake-embed', dims: FAKE_DIMS, embedding: encodeVector(new Float32Array(FAKE_DIMS).fill(0.1)), at: T0 })
    }
  })()
  startActive(store.db, OLD, T0)
  startBuilding(store.db, { model: 'fake-embed', dims: FAKE_DIMS }, T0)
  store.db.close()
})
afterEach(async () => {
  await daemon?.stop()
  rmSync(root, { recursive: true, force: true })
})

/** Rows still held for the retired space, read on a connection of the test's own. */
function oldRows(): number {
  const store = openStore(dataDir)
  try {
    return store.db.query<{ n: number }, { model: string }>('SELECT count(*) AS n FROM observation_vectors WHERE model = $model').get({ model: OLD.model })!.n
  } finally {
    store.db.close()
  }
}

const until = async (done: () => boolean, ms: number): Promise<boolean> => {
  const end = performance.now() + ms
  while (performance.now() < end) {
    if (done()) return true
    await Bun.sleep(20)
  }
  return done()
}

test('with the gate shut only the start\'s own slice runs; once it opens the timer finishes the sweep', async () => {
  let open = false
  const logs: string[] = []
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line), vectors: { embedder: fakeEmbedder(), tickMs: 20, upkeepReady: () => open } })
  // The start's slice switched spaces and swept one chunk; many ticks later nothing more has gone.
  expect(logs.some((line) => line.startsWith('vectors switched to fake-embed'))).toBe(true)
  await Bun.sleep(400)
  expect(oldRows()).toBe(OBSERVATIONS - SWEEP_CHUNK)
  open = true
  expect(await until(() => oldRows() === 0, 15_000)).toBe(true)
})

test('while writes are held (a checkpoint in flight) no upkeep slice runs; once they may, the sweep finishes', async () => {
  let writes = false
  const logs: string[] = []
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line), vectors: { embedder: fakeEmbedder(), tickMs: 20, upkeepReady: () => true, writesReady: () => writes } })
  expect(logs.some((line) => line.startsWith('vectors switched to fake-embed'))).toBe(true)
  await Bun.sleep(400)
  expect(oldRows()).toBe(OBSERVATIONS - SWEEP_CHUNK)
  writes = true
  expect(await until(() => oldRows() === 0, 15_000)).toBe(true)
})

test('left to itself the daemon opens the gate when its checkpoint worker has settled, and the sweep finishes', async () => {
  const logs: string[] = []
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line), vectors: { embedder: fakeEmbedder(), tickMs: 20 } })
  expect(await until(() => oldRows() === 0, 15_000)).toBe(true)
  // Settled one way or the other: on, or said to be off with the daemon's connection checkpointing.
  expect(logs.some((line) => line.startsWith('checkpoint worker on') || line.startsWith('checkpoint worker off'))).toBe(true)
})
