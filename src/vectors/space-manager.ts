// The daemon's upkeep of embedding spaces, one bounded step per index tick, on
// its own connection (the only one that writes vec0 tables). The target is the
// space the configured embedder writes into. A store with no space starts it
// as active. A different target is built beside the active space: search keeps
// the old space until every observation has a vector in the new one and its
// vec0 index is complete, then the new space becomes active and the old one's
// rows and table go, a chunk per step. Each step moves at most a few hundred
// vec0 rows and reads only index ranges (vec-index.ts reconcileWindow), so its
// cost does not grow with the store; a retired index goes a vector chunk at a
// time. Counts and model names are logged, never text.

import type { Database } from '../sqlite/types'
import {
  type StoredSpace, activeSpace, buildingSpace, promoteBuilding, removeSpace, spaceOf, startActive, startBuilding,
} from '../store/vector-spaces'
import { type VectorSpace, vectorCounts } from '../store/vector-store'
import { RECONCILE_CHUNK, RECONCILE_WINDOW, createVecIndex, dropVecIndexStep, reconcileWindow, vecIndexExists, writeVecRows } from './vec-index'

/** Rows of a dropped space removed per step; secure_delete zeroes each freed page, and a 1536-dimension row is 6 KB. */
export const SWEEP_CHUNK = 200
/**
 * A build switches over once fewer observations than one indexer batch wait
 * for a vector: on a busy store new ones arrive every tick, and the next
 * batch embeds them into the new space within seconds.
 */
export const PROMOTE_BACKLOG = 32

export interface SpaceStatus extends VectorSpace {
  indexed: number
  pending: number
  vecReady: boolean
}

export interface SpaceManager {
  /** One bounded turn of upkeep; true when work is left that another turn soon would move on (a pass to finish, rows or a table to drop). */
  step(): boolean
  /** The space search reads now; null before the first step on an empty store. */
  searchSpace(): StoredSpace | null
  /** The indexer wrote these rows into the target space. */
  written(rows: readonly { id: number; vector: Float32Array }[]): void
  status(): { active: SpaceStatus | null; building: SpaceStatus | null }
}

export interface SpaceManagerOptions {
  db: Database
  /** sqlite-vec is loaded on db; without it spaces still switch, and search scans. */
  vec0: boolean
  /** Null: no embedder, so nothing is built and nothing switches. */
  target: VectorSpace | null
  now: () => number
  log: (line: string) => void
  reconcileChunk?: number
  /** Observation ids per reconcile window; default RECONCILE_WINDOW. */
  window?: number
  /** Default PROMOTE_BACKLOG. */
  promoteBacklog?: number
  /** Times each part of a step under a name for the daemon's stall watch; default runs it as is. */
  step?: <T>(label: string, fn: () => T) => T
}

const same = (a: VectorSpace, b: VectorSpace): boolean => a.model === b.model && a.dims === b.dims
const VEC_TABLE = /^vec_space_(\d+)$/

/**
 * Runs fn with secure_delete FAST, then puts back the mode it found. For the
 * sweep of a retired space only: its rows and index hold vectors of
 * observations the store still keeps (a purge deletes its own vectors, with
 * secure_delete on), and zeroing them wrote a megabyte or more to the WAL per
 * slice, so checkpoints came often and one held the thread for seconds.
 */
export function withFastDelete<T>(db: Database, fn: () => T): T {
  const before = db.query<{ secure_delete: number }, []>('PRAGMA secure_delete').get()?.secure_delete ?? 1
  db.run('PRAGMA secure_delete = FAST')
  try {
    return fn()
  } finally {
    db.run(`PRAGMA secure_delete = ${before === 0 ? 'OFF' : before === 2 ? 'FAST' : 'ON'}`)
  }
}

interface Pass {
  /** Where the next window starts. */
  cursor: number
  /** The index was ready when this pass began: losing that during the pass means a vector was deleted behind the cursor. */
  readyAtStart: boolean
}

export function createSpaceManager(options: SpaceManagerOptions): SpaceManager {
  const { db, log, target } = options
  const chunk = options.reconcileChunk ?? RECONCILE_CHUNK
  const window = options.window ?? RECONCILE_WINDOW
  const backlog = options.promoteBacklog ?? PROMOTE_BACKLOG
  const passes = new Map<number, Pass>()
  const part = options.step ?? (<T>(_label: string, fn: () => T): T => fn())
  let sweeping = true
  // Without sqlite-vec nothing keeps the indexes current, so none may be trusted when it comes back.
  if (!options.vec0) db.run('UPDATE vector_spaces SET vec_ready = 0 WHERE vec_ready = 1')

  // The row goes now; its vector rows and vec0 table go in the sweep, a chunk per step.
  const drop = (space: StoredSpace): void => {
    removeSpace(db, space.id)
    passes.delete(space.id)
    sweeping = true
  }

  const ensureSpaces = (): void => {
    if (target === null) return
    const active = activeSpace(db)
    const building = buildingSpace(db)
    if (active === null) {
      startActive(db, target, options.now())
      log(`vectors space ${target.model} dims=${target.dims} started`)
      return
    }
    if (same(active, target)) {
      if (building !== null) {
        drop(building)
        log(`vectors build of ${building.model} dropped; ${target.model} is the choice again`)
      }
      return
    }
    if (building === null || !same(building, target)) {
      startBuilding(db, target, options.now(), (replaced) => {
        passes.delete(replaced.id)
        sweeping = true
      })
      log(`vectors building ${target.model} dims=${target.dims} beside ${active.model}`)
    }
  }

  /**
   * One window of a space's reconcile pass. A pass that reaches the end makes
   * the index ready, unless it began ready and lost that on the way (a vector
   * deleted behind it), or a project merge took index rows out during it
   * (vec_ready -1); then another pass runs. `ended`: this window finished a pass.
   */
  const upkeep = (space: StoredSpace): { more: boolean; ended: boolean } => {
    if (!vecIndexExists(db, space)) createVecIndex(db, space)
    const started = passes.get(space.id)
    // A new pass clears the merge mark, so one that lands after this point is seen at the end.
    if (started === undefined) db.query('UPDATE vector_spaces SET vec_ready = 0 WHERE id = ? AND vec_ready = -1').run(space.id)
    const pass = started ?? { cursor: 0, readyAtStart: space.vecReady }
    const result = reconcileWindow(db, space, pass.cursor, { window, limit: chunk })
    if (!result.end) {
      passes.set(space.id, { ...pass, cursor: result.next })
      return { more: true, ended: false }
    }
    passes.delete(space.id)
    if (pass.readyAtStart) return { more: false, ended: true }
    // Only from 0: 1 is already ready, and -1 means a merge took rows out behind this pass.
    if (db.query('UPDATE vector_spaces SET vec_ready = 1 WHERE id = ? AND vec_ready = 0').run(space.id).changes === 0) return { more: false, ended: true }
    log(`vectors index ready for ${space.model}`)
    return { more: false, ended: true }
  }

  /** buildEnded: a pass over the building index ended in this step, so it holds every vector stored before the step. */
  const maybePromote = (buildEnded: boolean): void => {
    const building = buildingSpace(db)
    if (building === null || vectorCounts(db, { model: building.model, dims: building.dims }).pending > backlog) return
    if (options.vec0 && !(buildEnded && building.vecReady)) return
    const old = promoteBuilding(db)
    if (old !== null) passes.delete(old.id)
    sweeping = true
    log(`vectors switched to ${building.model}${old === null ? '' : `; dropping ${old.model}`}`)
  }

  /** Rows and tables of spaces no longer listed, a chunk at a time; true while any are left. */
  const sweep = (): boolean => (sweeping ? withFastDelete(db, sweepChunk) : false)

  const sweepChunk = (): boolean => {
    const removed = db.query(
      `DELETE FROM observation_vectors WHERE id IN (SELECT v.id FROM observation_vectors v
         WHERE NOT EXISTS (SELECT 1 FROM vector_spaces s WHERE s.model = v.model AND s.dims = v.dims) LIMIT $limit)`,
    ).run({ limit: SWEEP_CHUNK }).changes
    let tablesLeft = false
    // Rows first, then tables: one slice never zeroes both a chunk of rows and a vector chunk.
    if (options.vec0 && removed === 0) {
      const listed = new Set(db.query<{ id: number }, []>('SELECT id FROM vector_spaces').all().map((row) => row.id))
      const retired = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_space_%'").all()
        .map(({ name }) => VEC_TABLE.exec(name)?.[1]).filter((id): id is string => id !== undefined && !listed.has(Number(id)))
      // One table a step, a vector chunk at a time, until it is gone.
      if (retired.length > 0) tablesLeft = !dropVecIndexStep(db, { id: Number(retired[0]) }) || retired.length > 1
    }
    sweeping = removed > 0 || tablesLeft
    return sweeping
  }

  const statusOf = (space: StoredSpace | null): SpaceStatus | null =>
    space === null ? null : { model: space.model, dims: space.dims, ...vectorCounts(db, { model: space.model, dims: space.dims }), vecReady: space.vecReady }

  return {
    step: () => {
      ensureSpaces()
      let more = false
      let buildEnded = true
      if (options.vec0) {
        const active = activeSpace(db)
        // A ready active index keeps a slow pass going, for rows purged or moved under it.
        if (active !== null) more = part(`reconcile ${active.model}`, () => upkeep(active)).more && !active.vecReady
        const building = buildingSpace(db)
        if (building !== null) {
          const turn = part(`reconcile ${building.model}`, () => upkeep(building))
          more = turn.more || more
          buildEnded = turn.ended
        }
      }
      part('promote', () => maybePromote(buildEnded))
      return part('sweep', sweep) || more
    },
    searchSpace: () => activeSpace(db),
    written: (rows) => {
      if (!options.vec0 || target === null || rows.length === 0) return
      const space = spaceOf(db, target)
      if (space === null || !vecIndexExists(db, space)) return
      const projects = new Map(db.query<{ id: number; project: string }, { ids: string }>(
        'SELECT id, project_key AS project FROM observations WHERE id IN (SELECT value FROM json_each($ids))',
      ).all({ ids: JSON.stringify(rows.map((row) => row.id)) }).map((row) => [row.id, row.project]))
      writeVecRows(db, space, rows.flatMap((row) => {
        const project = projects.get(row.id)
        return project === undefined ? [] : [{ id: row.id, project, vector: row.vector }]
      }))
    },
    status: () => ({ active: statusOf(activeSpace(db)), building: statusOf(buildingSpace(db)) }),
  }
}
