// Links between observations (D2: "later observations can mark earlier ones
// as contradicted"). The observer proposes a link from a new observation to
// one the session was shown; every accepted link is stored, and an `updates`
// or `contradicts` link also hides the older row by setting its
// contradicted_by, which packs and MCP already skip.
//
// Evidence rule: an interpretation cannot overturn a tool-verified or
// user-stated row. Such a link is recorded but hides nothing. Anything else
// may overturn anything, as long as the newer row is not older than the one
// it overturns and both sit in one project. The rule lives in one SQL
// statement (SETTLE) so the write path and a purge's re-settle cannot drift.

import type { EvidenceStrength } from '../evidence'
import type { ObservationRelation, RelationKind } from '../observer/types'
import type { Database } from '../sqlite/types'

export interface LinkedObservation {
  id: number
  title: string
  evidence: string
  kind: RelationKind
  /** outgoing: this observation names the other; incoming: the other names this one. */
  direction: 'outgoing' | 'incoming'
  /** True when this link is the one that set the target's contradicted_by. */
  applied: boolean
  /** The other row is not contradicted; only a current confirmer counts toward "confirmed by". */
  current: boolean
  createdAt: number
}

/** The TypeScript statement of the rule; OVERTURNS below is the same rule in SQL. */
export function canOverturn(newer: EvidenceStrength, older: EvidenceStrength): boolean {
  return !(newer === 'interpretation' && older !== 'interpretation')
}

const OVERTURNS = "NOT (f.evidence = 'interpretation' AND t.evidence <> 'interpretation')"

/** The earliest remaining link that may hide row t. */
const OVERTURNING_LINK = `SELECT f.id FROM observation_links l JOIN observations f ON f.id = l.from_id
  WHERE l.to_id = t.id AND l.kind IN ('updates', 'contradicts') AND f.project_key = t.project_key
    AND f.occurred_at >= t.occurred_at AND ${OVERTURNS}
  ORDER BY f.occurred_at, f.id LIMIT 1`

const SETTLE = `UPDATE observations AS t SET contradicted_by = (${OVERTURNING_LINK})
  WHERE t.id IN (SELECT value FROM json_each($ids)) AND t.contradicted_by IS NULL AND EXISTS (${OVERTURNING_LINK})
  RETURNING id`

const INSERT = `INSERT OR IGNORE INTO observation_links (from_id, to_id, kind, created_at)
  SELECT $from, $to, $kind, $now WHERE $from <> $to AND EXISTS (
    SELECT 1 FROM observations f JOIN observations t ON t.project_key = f.project_key WHERE f.id = $from AND t.id = $to)
  RETURNING to_id`

const LINKS_OF = `SELECT o.id, o.title, o.evidence, l.kind, 'outgoing' AS direction, o.contradicted_by = l.from_id AS applied,
      o.contradicted_by IS NULL AS current, l.created_at AS createdAt
    FROM observation_links l JOIN observations o ON o.id = l.to_id WHERE l.from_id = $id
  UNION ALL
  SELECT o.id, o.title, o.evidence, l.kind, 'incoming', t.contradicted_by = l.from_id, o.contradicted_by IS NULL, l.created_at
    FROM observation_links l JOIN observations o ON o.id = l.from_id JOIN observations t ON t.id = l.to_id WHERE l.to_id = $id
  ORDER BY 5 DESC, 1`

export type ContradictionKind = Extract<RelationKind, 'updates' | 'contradicts'>

/**
 * A select-list column naming the link kind behind `<alias>.contradicted_by`:
 * a primary-key lookup on observation_links, NULL for a row hidden by hand
 * before v5 (readers render that as "contradicted by"). Where links outnumber
 * one per pair, contradicts wins: it is the stronger claim.
 */
export function contradictionKindColumn(alias: string): string {
  return `(SELECT l.kind FROM observation_links l WHERE l.from_id = ${alias}.contradicted_by AND l.to_id = ${alias}.id
    AND l.kind IN ('updates', 'contradicts') ORDER BY l.kind = 'contradicts' DESC LIMIT 1) AS contradictionKind`
}

// --- Confirmation ranking (P1-I). Read helpers only; confirms never hides. ---

/** Each current confirmer adds this to a row's rank, up to CONFIRM_BOOST_CAP of them. */
export const CONFIRM_BOOST_STEP = 0.3
export const CONFIRM_BOOST_CAP = 3

/**
 * 0, 0.3, 0.6, then 0.9 for three or more confirmers. The cap stays below 1,
 * one evidence tier in the pack's rank, so confirmation reorders rows within
 * a tier and never lifts an interpretation over a tool-verified row.
 */
export function confirmBoost(confirmedBy: number): number {
  return Math.min(Math.max(0, confirmedBy), CONFIRM_BOOST_CAP) * CONFIRM_BOOST_STEP
}

/** The same boost in SQL, for an integer count expression. */
export function confirmBoostSql(count: string): string {
  return `(min(${count}, ${CONFIRM_BOOST_CAP}) * ${CONFIRM_BOOST_STEP})`
}

/**
 * A select-list column: how many current (not contradicted) observations of
 * the same project have a confirms link to `<alias>`. A purged source leaves
 * no link (cascade); a contradicted one stops counting. Served by the to_id index.
 */
export function confirmationsColumn(alias: string): string {
  return `(SELECT count(DISTINCT l.from_id) FROM observation_links l JOIN observations f ON f.id = l.from_id
    WHERE l.to_id = ${alias}.id AND l.kind = 'confirms' AND f.contradicted_by IS NULL AND f.project_key = ${alias}.project_key) AS confirmedBy`
}

/** A read-only reader may meet a store from before v5. */
export function hasLinksTable(db: Database): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'observation_links'").get() !== null
}

/** The row a content hash names; a retried batch finds the row it stored the first time. */
export function observationIdByHash(db: Database, projectKey: string, contentHash: string): number | null {
  return db.query<{ id: number }, { projectKey: string; contentHash: string }>(
    'SELECT id FROM observations WHERE project_key = $projectKey AND content_hash = $contentHash',
  ).get({ projectKey, contentHash })?.id ?? null
}

/**
 * Returns how many links are new; the unique key makes a retried batch add none.
 * Counts come from RETURNING rows: bun's `changes` can report an earlier
 * statement's FTS trigger writes when this one inserts nothing.
 */
export function insertLinks(db: Database, fromId: number, relations: readonly ObservationRelation[], now: number): number {
  const statement = db.query<{ to_id: number }, Record<string, string | number>>(INSERT)
  return relations.reduce((added, relation) => added + statement.all({ from: fromId, to: relation.observationId, kind: relation.kind, now }).length, 0)
}

/** Hides each named row that is not hidden yet and has a link allowed to hide it; returns how many it hid. */
export function settleContradictions(db: Database, ids: readonly number[]): number {
  if (ids.length === 0) return 0
  return db.query<{ id: number }, { ids: string }>(SETTLE).all({ ids: JSON.stringify([...new Set(ids)]) }).length
}

/** Rows that rows in `fromIds` link to or contradict, outside `fromIds`: what a purge of them may reveal. */
export function linkTargets(db: Database, fromIds: readonly number[]): number[] {
  if (fromIds.length === 0) return []
  return db.query<{ id: number }, { ids: string }>(
    `SELECT to_id AS id FROM observation_links WHERE from_id IN (SELECT value FROM json_each($ids))
     UNION SELECT id FROM observations WHERE contradicted_by IN (SELECT value FROM json_each($ids))
     EXCEPT SELECT value FROM json_each($ids) ORDER BY 1`,
  ).all({ ids: JSON.stringify(fromIds) }).map((row) => row.id)
}

/** Links touching one observation, both directions, with whether each one is what hides its target. */
export function linksOf(db: Database, id: number): LinkedObservation[] {
  return db.query<Omit<LinkedObservation, 'applied' | 'current'> & { applied: number | null; current: number }, { id: number }>(LINKS_OF)
    .all({ id })
    .map((row) => ({ ...row, applied: row.applied === 1, current: row.current === 1 }))
}
