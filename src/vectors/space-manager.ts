// The daemon's upkeep of embedding spaces, one bounded step per index tick, on
// its own connection (the only one that writes vec0 tables). The target is the
// space the configured embedder writes into. A store with no space starts it
// as active. A different target is built beside the active space: search keeps
// the old space until every observation has a vector in the new one and its
// vec0 index is complete, then the new space becomes active and the old one's
// rows and table go, a chunk per step. Each step moves at most a few hundred
// vec0 rows, so it never holds the daemon's thread for long. Counts and model
// names are logged, never text.

import type { Database } from '../sqlite/types'
import {
  type StoredSpace, activeSpace, buildingSpace, promoteBuilding, removeSpace, setVecReady, spaceOf, startActive, startBuilding,
} from '../store/vector-spaces'
import { type VectorSpace, vectorCounts } from '../store/vector-store'
import { RECONCILE_CHUNK, createVecIndex, dropVecIndex, reconcileVecIndex, vecIndexExists, writeVecRows } from './vec-index'

/** Rows of a dropped space deleted per step. */
export const SWEEP_CHUNK = 2_000
/** A ready active index is reconciled every this many steps, for rows purged under it. */
export const ACTIVE_RECONCILE_EVERY = 6
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
  step(): void
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
  /** Default PROMOTE_BACKLOG. */
  promoteBacklog?: number
}

const same = (a: VectorSpace, b: VectorSpace): boolean => a.model === b.model && a.dims === b.dims
const VEC_TABLE = /^vec_space_(\d+)$/

export function createSpaceManager(options: SpaceManagerOptions): SpaceManager {
  const { db, log, target } = options
  const chunk = options.reconcileChunk ?? RECONCILE_CHUNK
  const backlog = options.promoteBacklog ?? PROMOTE_BACKLOG
  let steps = 0
  let sweeping = true
  // Without sqlite-vec nothing keeps the indexes current, so none may be trusted when it comes back.
  if (!options.vec0) db.run('UPDATE vector_spaces SET vec_ready = 0 WHERE vec_ready = 1')

  const drop = (space: StoredSpace): void => {
    removeSpace(db, space.id)
    if (options.vec0) dropVecIndex(db, space)
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
        if (options.vec0) dropVecIndex(db, replaced)
        sweeping = true
      })
      log(`vectors building ${target.model} dims=${target.dims} beside ${active.model}`)
    }
  }

  /** Brings a space's index a chunk closer; true when nothing was left. */
  const upkeep = (space: StoredSpace, always: boolean): boolean => {
    if (!vecIndexExists(db, space)) createVecIndex(db, space)
    if (space.vecReady && !always) return true
    const result = reconcileVecIndex(db, space, chunk)
    if (result.done && !space.vecReady) {
      setVecReady(db, space.id, true)
      log(`vectors index ready for ${space.model}`)
    }
    return result.done
  }

  const maybePromote = (buildDone: boolean): void => {
    const building = buildingSpace(db)
    if (building === null || vectorCounts(db, { model: building.model, dims: building.dims }).pending > backlog) return
    if (options.vec0 && !(buildDone && buildingSpace(db)!.vecReady)) return
    const old = promoteBuilding(db)
    sweeping = true
    log(`vectors switched to ${building.model}${old === null ? '' : `; dropping ${old.model}`}`)
  }

  /** Rows and tables of spaces no longer listed, a chunk at a time. */
  const sweep = (): void => {
    if (!sweeping) return
    const deleted = db.query(
      `DELETE FROM observation_vectors WHERE id IN (SELECT v.id FROM observation_vectors v
         WHERE NOT EXISTS (SELECT 1 FROM vector_spaces s WHERE s.model = v.model AND s.dims = v.dims) LIMIT $limit)`,
    ).run({ limit: SWEEP_CHUNK }).changes
    if (options.vec0) {
      const listed = new Set(db.query<{ id: number }, []>('SELECT id FROM vector_spaces').all().map((row) => row.id))
      for (const { name } of db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_space_%'").all()) {
        const id = VEC_TABLE.exec(name)?.[1]
        if (id !== undefined && !listed.has(Number(id))) dropVecIndex(db, { id: Number(id) })
      }
    }
    if (deleted < SWEEP_CHUNK) sweeping = false
  }

  const statusOf = (space: StoredSpace | null): SpaceStatus | null =>
    space === null ? null : { model: space.model, dims: space.dims, ...vectorCounts(db, { model: space.model, dims: space.dims }), vecReady: space.vecReady }

  return {
    step: () => {
      steps += 1
      ensureSpaces()
      let buildDone = true
      if (options.vec0) {
        const active = activeSpace(db)
        if (active !== null) upkeep(active, steps % ACTIVE_RECONCILE_EVERY === 0)
        const building = buildingSpace(db)
        // A space about to become active is reconciled every step, so it is complete when it switches.
        if (building !== null) buildDone = upkeep(building, true)
      }
      maybePromote(buildDone)
      sweep()
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
