// Read-only queries behind the dashboard's memory browser. Same shape as the
// MCP reader (src/mcp/reader.ts): named parameters, one optional clause per
// filter, observations and their FTS index only. The events table is never
// read here, so no payload can reach a dashboard answer; an observation
// carries its source event ids and nothing more. The caller sanitizes the
// search text with src/mcp/fts.ts before it becomes `match`. A detail also
// carries its observation links both ways (src/store/observation-links.ts).
// Every row carries confirmedBy, as reader.ts counts it: 0 on a store from
// before v5, which has no observation_links.

import { type FullObservation, type IndexRow, stringList } from '../mcp/reader'
import type { Database } from '../sqlite/types'
import { type LinkedObservation, confirmationsColumn, contradictionKindColumn, hasLinksTable, linksOf } from './observation-links'

export interface BrowseFilters {
  project: string | null
  host: string | null
  type: string | null
  evidence: string | null
  /** An FTS5 MATCH expression built by ftsMatch(), or null for no search. */
  match: string | null
  limit: number
  offset: number
}

export interface BrowsePage {
  rows: IndexRow[]
  total: number
}

export interface RelatedObservation {
  id: number
  title: string
  evidence: string
  relation: 'contradicted_by' | 'contradicts'
}

export interface ObservationDetail extends FullObservation {
  createdAt: number
  projectName: string | null
  related: RelatedObservation[]
  /** confirms / updates / contradicts links, outgoing and incoming. */
  links: LinkedObservation[]
}

export interface FacetCount {
  value: string
  label: string
  observations: number
}

export interface Facets {
  projects: FacetCount[]
  hosts: FacetCount[]
  types: FacetCount[]
}

type Bindings = Record<string, string | number | null>

function indexColumns(hasLinks: boolean): string {
  return `o.id, o.project_key AS projectKey, o.host, o.type, o.evidence, o.title,
  o.contradicted_by AS contradictedBy, ${hasLinks ? contradictionKindColumn('o') : 'NULL AS contradictionKind'}, o.occurred_at AS occurredAt,
  ${hasLinks ? confirmationsColumn('o') : '0 AS confirmedBy'}`
}
const FILTERED = `($project IS NULL OR o.project_key = $project)
  AND ($host IS NULL OR o.host = $host) AND ($type IS NULL OR o.type = $type)
  AND ($evidence IS NULL OR ($evidence = 'contradicted' AND o.contradicted_by IS NOT NULL) OR o.evidence = $evidence)
  AND ($match IS NULL OR o.id IN (SELECT rowid FROM observations_fts WHERE observations_fts MATCH $match))`

const pageSql = (hasLinks: boolean): string => `SELECT ${indexColumns(hasLinks)} FROM observations o WHERE ${FILTERED}
  ORDER BY o.occurred_at DESC, o.id DESC LIMIT $limit OFFSET $offset`
const detailSql = (hasLinks: boolean): string => `SELECT ${indexColumns(hasLinks)}, o.session_id AS sessionId, o.prompt_number AS promptNumber, o.narrative, o.facts, o.files,
      o.source_event_ids AS sourceEventIds, o.observer_model AS observerModel, o.created_at AS createdAt, p.display_name AS projectName
    FROM observations o LEFT JOIN projects p ON p.key = o.project_key WHERE o.id = $id`

const SQL = {
  total: `SELECT count(*) AS n FROM observations o WHERE ${FILTERED}`,
  related: `SELECT id, title, evidence, CASE WHEN id = $by THEN 'contradicted_by' ELSE 'contradicts' END AS relation
    FROM observations WHERE id = $by OR contradicted_by = $id ORDER BY id`,
  projects: `SELECT o.project_key AS value, coalesce(p.display_name, o.project_key) AS label, count(*) AS observations
    FROM observations o LEFT JOIN projects p ON p.key = o.project_key GROUP BY o.project_key ORDER BY observations DESC, value`,
  hosts: 'SELECT host AS value, host AS label, count(*) AS observations FROM observations GROUP BY host ORDER BY observations DESC, value',
  types: 'SELECT type AS value, type AS label, count(*) AS observations FROM observations GROUP BY type ORDER BY observations DESC, value',
} as const

type StoredDetail = Omit<ObservationDetail, 'facts' | 'files' | 'sourceEventIds' | 'contradicts' | 'related' | 'links'> & {
  facts: string
  files: string
  sourceEventIds: string
}

function filterBindings(filters: BrowseFilters): Bindings {
  const { project, host, type, evidence, match } = filters
  return { project, host, type, evidence, match }
}

/** Newest first; `total` counts every row the filters match, for the pager. */
export function browseObservations(db: Database, filters: BrowseFilters): BrowsePage {
  const bindings = filterBindings(filters)
  const rows = db.query<IndexRow, Bindings>(pageSql(hasLinksTable(db))).all({ ...bindings, limit: filters.limit, offset: filters.offset })
  const total = db.query<{ n: number }, Bindings>(SQL.total).get(bindings)?.n ?? 0
  return { rows, total }
}

/** One observation with its contradiction and relation links both ways; null when the id is unknown. */
export function observationDetail(db: Database, id: number): ObservationDetail | null {
  const row = db.query<StoredDetail, { id: number }>(detailSql(hasLinksTable(db))).get({ id })
  if (row === null) return null
  const related = db.query<RelatedObservation, { id: number; by: number }>(SQL.related).all({ id, by: row.contradictedBy ?? -1 })
  return {
    ...row,
    facts: stringList(row.facts),
    files: stringList(row.files),
    sourceEventIds: stringList(row.sourceEventIds),
    contradicts: related.filter((other) => other.relation === 'contradicts').map((other) => other.id),
    related,
    links: linksOf(db, id),
  }
}

/** The values the browser's filter menus offer, with how many observations each has. */
export function observationFacets(db: Database): Facets {
  const all = (sql: string): FacetCount[] => db.query<FacetCount, []>(sql).all()
  return { projects: all(SQL.projects), hosts: all(SQL.hosts), types: all(SQL.types) }
}
