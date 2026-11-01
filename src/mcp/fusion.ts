// Hybrid ranking for the MCP search tool (P2-A; plan: "FTS5 BM25 and vector
// search in parallel, merged with reciprocal rank fusion"). RRF uses ranks
// only, so bm25 (unbounded, lower is better, already scaled by the confirms
// boost) and cosine distance (0 to 2) never need a common scale; a row in
// both lists outranks a row at the top of one. Vector search always returns
// k neighbours, related or not, so hits past MAX_VECTOR_DISTANCE are not
// matches and are dropped before fusing.

import type { IndexRow } from './reader'

/** The constant from Cormack et al. (2009); it damps how much rank 1 beats rank 2. */
export const RRF_K = 60
/**
 * Tuned 2026-11-01 on the live store: random pairs of observations in one
 * project sit at a median distance of 0.675 (p5 0.52), so 0.8 let through
 * nearly every unrelated row. A hit past 0.7 is farther away than a typical
 * unrelated one. The prompt-time ranking (src/context/related.ts) fuses through
 * here too.
 */
export const MAX_VECTOR_DISTANCE = 0.7

export interface VectorRow<T extends { id: number } = IndexRow> {
  row: T
  distance: number
}

/** Each list in its own best-first order; the result is best-first, each row once. Ties keep FTS order, then newest id. */
export function fuseRanks<T extends { id: number }>(fts: readonly T[], vector: readonly VectorRow<T>[]): T[] {
  const scores = new Map<number, { row: T; score: number; ftsRank: number }>()
  const add = (row: T, rank: number, ftsRank: number): void => {
    const seen = scores.get(row.id)
    const score = 1 / (RRF_K + rank + 1)
    scores.set(row.id, seen === undefined ? { row, score, ftsRank } : { ...seen, score: seen.score + score, ftsRank: Math.min(seen.ftsRank, ftsRank) })
  }
  fts.forEach((row, rank) => add(row, rank, rank))
  vector.filter((hit) => hit.distance <= MAX_VECTOR_DISTANCE).forEach((hit, rank) => add(hit.row, rank, Number.POSITIVE_INFINITY))
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.ftsRank - b.ftsRank || b.row.id - a.row.id)
    .map((entry) => entry.row)
}
