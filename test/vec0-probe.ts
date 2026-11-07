// Run by src/vectors/sqlite-vec.integration.test.ts in its own process, the
// way the daemon loads vec0: through sqlite3mc (KINFOLD_SQLITE3MC_LIB, inherited
// from the test run). Args: a scratch data dir and the pinned vec0 member.
// Prints one JSON line: the loader's answer and the nearest-observation
// results the test checks.

import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { seedObservation } from '../src/context/test-support'
import { T0, seedSession } from '../src/observer/test-support'
import { openStore } from '../src/store/db'
import { distancesFor, nearestObservations, upsertVectors } from '../src/store/vector-store'
import { upsertProject } from '../src/store/writes'
import { loadVec0, vec0Path } from '../src/vectors/extension'

const [dataDir, vec0] = process.argv.slice(2)
if (dataDir === undefined || vec0 === undefined) throw new Error('usage: vec0-probe.ts <dataDir> <vec0 member>')

const store = openStore(dataDir)
mkdirSync(dirname(vec0Path(dataDir)), { recursive: true })
copyFileSync(vec0, vec0Path(dataDir))
const support = loadVec0(store.db, dataDir)

for (const key of ['a', 'b']) upsertProject(store.db, { key, kind: 'path', displayName: key }, T0)
const session = seedSession(store, 'claude-code', 'probe')
const seed = (project: string, title: string) => seedObservation(store, { sessionId: session, projectKey: project, host: 'claude-code', title, at: T0 })
const ids = { east: seed('a', 'east'), north: seed('a', 'north'), west: seed('a', 'west'), otherProject: seed('b', 'east elsewhere'), otherModel: seed('a', 'east, old model') }
const hashOf = (id: number) => (store.db.query('SELECT content_hash AS h FROM observations WHERE id = ?').get(id) as { h: string }).h
const at = (id: number, x: number, y: number) => ({ id, contentHash: hashOf(id), vector: Float32Array.from([x, y]) })
const v = (x: number, y: number) => Float32Array.from([x, y])
upsertVectors(store.db, 'm', [at(ids.east, 1, 0), at(ids.north, 0, 1), at(ids.west, -1, 0), at(ids.otherProject, 1, 0)], T0)
upsertVectors(store.db, 'old', [at(ids.otherModel, 1, 0)], T0)

const query = { model: 'm', vector: v(1, 0.1), k: 10 }
const out = support.ok
  ? {
      support, ids,
      inProject: nearestObservations(store.db, { ...query, project: 'a' }),
      everywhere: nearestObservations(store.db, { ...query, project: null }),
      // West is last of three in the project; with k=1 only the extra query gives its distance. The other project's row stays out.
      extra: distancesFor(store.db, { model: 'm', vector: query.vector, project: 'a', ids: [ids.west, ids.otherProject, 999] }),
    }
  : { support, ids }
store.db.close()
process.stdout.write(`${JSON.stringify(out)}\n`)
