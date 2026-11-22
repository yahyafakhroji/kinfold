// Brings a test's vec0 index in line with the stored vectors in one call. The
// daemon never does it this way: it walks the index a bounded window at a time
// (reconcileWindow, vec-index.ts), because the anti-joins here read both whole
// tables and held the daemon's thread for seconds on a large store. Tests use
// this to seed an index, so it lives with them and not in what ships.

import type { Database } from '../sqlite/types'
import { type IndexedSpace, RECONCILE_CHUNK, tableOf } from './vec-index'

/** Deletes are cheaper and carry purged data, so a pass removes more of them. */
const REMOVE_CHUNK = 5_000

export interface ReconcileResult {
  added: number
  removed: number
  /** Nothing was left over this pass. */
  done: boolean
}

/** Up to `limit` rows each way: index rows with no stored vector out, stored vectors with no index row in. */
export function reconcileVecIndex(db: Database, space: IndexedSpace, limit: number = RECONCILE_CHUNK): ReconcileResult {
  const table = tableOf(space)
  const params = { model: space.model, dims: space.dims, limit }
  const removeLimit = Math.max(limit, REMOVE_CHUNK)
  const stale = db.query<{ id: number }, typeof params>(
    `SELECT observation_id AS id FROM ${table}
     WHERE observation_id NOT IN (SELECT observation_id FROM observation_vectors WHERE model = $model AND dims = $dims) LIMIT $limit`,
  ).all({ ...params, limit: removeLimit })
  // A row filed under a project its observation has left (a project merge or split, store/project-merge.ts) goes out, and comes back in below under the right one.
  const moved = db.query<{ id: number }, { limit: number }>(
    `SELECT v.observation_id AS id FROM ${table} v JOIN observations o ON o.id = v.observation_id WHERE v.project_key <> o.project_key LIMIT $limit`,
  ).all({ limit: removeLimit })
  stale.push(...moved.filter((row) => !stale.some((known) => known.id === row.id)))
  const remove = db.prepare(`DELETE FROM ${table} WHERE observation_id = $id`)
  const insert = db.prepare(`INSERT INTO ${table} (observation_id, project_key, embedding) VALUES ($id, $project, $embedding)`)
  // Read after the removals, so a row taken out for its project comes back in the same pass.
  const missing = db.transaction(() => {
    for (const row of stale) remove.run({ id: row.id })
    const rows = db.query<{ id: number; project: string; embedding: Uint8Array }, typeof params>(
      `SELECT v.observation_id AS id, o.project_key AS project, v.embedding AS embedding
       FROM observation_vectors v JOIN observations o ON o.id = v.observation_id
       WHERE v.model = $model AND v.dims = $dims AND v.observation_id NOT IN (SELECT observation_id FROM ${table}) LIMIT $limit`,
    ).all(params)
    for (const row of rows) insert.run({ id: row.id, project: row.project, embedding: row.embedding })
    return rows
  })()
  return { added: missing.length, removed: stale.length, done: missing.length < limit && stale.length < removeLimit }
}
