// Rows of vector_spaces (v14): which embedding space search uses and which one
// is being built. At most one of each (a unique index on state). A switch
// builds the new space beside the active one; once every observation has a
// vector there, promoteBuilding makes it active and hands back the old space,
// whose rows and vec0 table the daemon then drops.

import type { Database } from '../sqlite/types'
import type { VectorSpace } from './vector-store'

export interface StoredSpace extends VectorSpace {
  id: number
  state: 'active' | 'building'
  /** Its vec0 index holds every vector of the space. */
  vecReady: boolean
}

interface Row {
  id: number
  model: string
  dims: number
  state: 'active' | 'building'
  vecReady: number
}

const COLUMNS = 'id, model, dims, state, vec_ready AS vecReady'
const toSpace = (row: Row | null): StoredSpace | null => (row === null ? null : { id: row.id, model: row.model, dims: row.dims, state: row.state, vecReady: row.vecReady === 1 })

function inState(db: Database, state: 'active' | 'building'): StoredSpace | null {
  return toSpace(db.query<Row, { state: string }>(`SELECT ${COLUMNS} FROM vector_spaces WHERE state = $state`).get({ state }))
}

export const activeSpace = (db: Database): StoredSpace | null => inState(db, 'active')
export const buildingSpace = (db: Database): StoredSpace | null => inState(db, 'building')

export function spaceOf(db: Database, space: VectorSpace): StoredSpace | null {
  return toSpace(db.query<Row, { model: string; dims: number }>(`SELECT ${COLUMNS} FROM vector_spaces WHERE model = $model AND dims = $dims`).get({ model: space.model, dims: space.dims }))
}

function insert(db: Database, space: VectorSpace, state: 'active' | 'building', now: number): StoredSpace {
  db.query('INSERT INTO vector_spaces (model, dims, state, created_at) VALUES ($model, $dims, $state, $now)').run({ model: space.model, dims: space.dims, state, now })
  return spaceOf(db, space)!
}

/** The first space of a store with none. */
export function startActive(db: Database, space: VectorSpace, now: number): StoredSpace {
  return insert(db, space, 'active', now)
}

/**
 * Marks the space to build. An earlier build of another space is removed and
 * handed to onReplaced, so its rows and table can go.
 */
export function startBuilding(db: Database, space: VectorSpace, now: number, onReplaced?: (space: StoredSpace) => void): StoredSpace {
  return db.transaction(() => {
    const current = buildingSpace(db)
    if (current !== null && current.model === space.model && current.dims === space.dims) return current
    if (current !== null) {
      db.query('DELETE FROM vector_spaces WHERE id = $id').run({ id: current.id })
      onReplaced?.(current)
    }
    return insert(db, space, 'building', now)
  })()
}

export function setVecReady(db: Database, id: number, ready: boolean): void {
  db.query('UPDATE vector_spaces SET vec_ready = $ready WHERE id = $id').run({ id, ready: ready ? 1 : 0 })
}

/** The building space becomes active; returns the space it replaced, or null. */
export function promoteBuilding(db: Database): StoredSpace | null {
  return db.transaction(() => {
    const building = buildingSpace(db)
    if (building === null) return null
    const old = activeSpace(db)
    if (old !== null) db.query('DELETE FROM vector_spaces WHERE id = $id').run({ id: old.id })
    db.query("UPDATE vector_spaces SET state = 'active' WHERE id = $id").run({ id: building.id })
    return old
  })()
}

/** Forgets a space entirely; the caller drops its rows and table. */
export function removeSpace(db: Database, id: number): void {
  db.query('DELETE FROM vector_spaces WHERE id = $id').run({ id })
}
