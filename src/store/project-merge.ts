// One repo, one project. A project key is the git remote (then the repo
// root, then the folder), so a renamed remote or a fork made a second project
// for the same memory. A repo is known by its first commit: when a key comes
// in whose first commit another project has, the two merge, and the key seen
// last wins when it is remote-based (the user's rule, 2026-11-17: forks merge
// too). The merged key stays as an alias, so a clone still on the old remote
// lands on the new key. Each merge keeps the row ids it moved, so `kinfold
// project split` puts back exactly those and holds the key out of automatic
// merging. A folder with no git never merges on its own; `kinfold project
// merge` does it on request. Logs and answers carry keys, names and counts.

import type { Database } from '../sqlite/types'
import type { ProjectKey } from './project-key'

/**
 * Tables whose rows belong to a project by project_key, recorded by rowid.
 * turn_usage has no rowid; its rows follow their session. Context packs are
 * rebuilt instead of moved.
 */
const PROJECT_TABLES = ['sessions', 'observations', 'injections', 'injections_v3', 'mcp_reads', 'related_served'] as const
type ProjectTable = (typeof PROJECT_TABLES)[number]
type Moved = Partial<Record<ProjectTable, number[]>>
/** Aliases are followed this far; a longer chain means a cycle, and the key is used as is. */
const MAX_ALIAS_HOPS = 8

export type MergeReason = 'same-repo' | 'manual'

/**
 * The key a key's memory lives under now: itself, or the project it was
 * merged into. A read-only reader can meet a store from before v16, with no
 * merged_into column; there every key is its own.
 */
export function canonicalKey(db: Database, key: string): string {
  let current = key
  try {
    for (let hop = 0; hop < MAX_ALIAS_HOPS; hop += 1) {
      const row = db.query<{ into: string | null }, [string]>('SELECT merged_into AS "into" FROM projects WHERE key = ?').get(current)
      if (row?.into === null || row?.into === undefined) return current
      current = row.into
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('no such column')) return key
    throw error
  }
  return key
}

interface ProjectRow {
  key: string
  kind: string
  name: string
  lastAt: number | null
}

function projectsWithRoot(db: Database, root: string): ProjectRow[] {
  return db.query<ProjectRow, [string]>(
    `SELECT p.key, p.key_kind AS kind, p.display_name AS name, (SELECT max(last_event_at) FROM sessions s WHERE s.project_key = p.key) AS lastAt
     FROM projects p WHERE p.root_commit = ? AND p.merged_into IS NULL AND p.merge_held = 0`,
  ).all(root)
}

/** The project the others of one repo merge into: the key just seen when it is remote-based, else the most recently active remote-based key, else the most recently active. */
function winnerOf(rows: readonly ProjectRow[], seen: string | null): ProjectRow {
  const remote = rows.filter((row) => row.kind === 'git-remote')
  const justSeen = remote.find((row) => row.key === seen)
  if (justSeen !== undefined) return justSeen
  const pool = remote.length > 0 ? remote : rows
  return [...pool].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || (b.key === seen ? 1 : 0) - (a.key === seen ? 1 : 0))[0]!
}

export interface MergeDone {
  fromKey: string
  intoKey: string
  from: string
  into: string
}

/** Merges every project of the repo into its winner; returns what merged. */
function mergeRepo(db: Database, root: string, seen: string | null, now: number): MergeDone[] {
  const rows = projectsWithRoot(db, root)
  if (rows.length < 2) return []
  const winner = winnerOf(rows, seen)
  return rows.filter((row) => row.key !== winner.key).map((row) => {
    applyMerge(db, row.key, winner.key, 'same-repo', now)
    return { fromKey: row.key, intoKey: winner.key, from: row.name, into: winner.name }
  })
}

/**
 * Records a project as an event names it and returns the key to store the
 * event under: its alias target when it was merged, the repo's winner when
 * this key's first commit matches another project. Run inside the ingest
 * batch's transaction, so a merge and the event that caused it commit as one.
 */
export function registerProject(db: Database, project: ProjectKey, now: number): string {
  db.query(
    `INSERT INTO projects (key, key_kind, display_name, created_at, root_commit) VALUES ($key, $kind, $displayName, $now, $root)
     ON CONFLICT (key) DO UPDATE SET root_commit = coalesce(projects.root_commit, excluded.root_commit)`,
  ).run({ key: project.key, kind: project.kind, displayName: project.displayName, now, root: project.rootCommit ?? null })
  if (project.rootCommit !== undefined) mergeRepo(db, project.rootCommit, project.key, now)
  return canonicalKey(db, project.key)
}

function hasTable(db: Database, table: string): boolean {
  return db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.n === 1
}

function rowsOf(db: Database, key: string): Moved {
  const moved: Moved = {}
  for (const table of PROJECT_TABLES) {
    if (!hasTable(db, table)) continue
    const ids = db.query<{ id: number }, [string]>(`SELECT rowid AS id FROM ${table} WHERE project_key = ?`).all(key).map((row) => row.id)
    if (ids.length > 0) moved[table] = ids
  }
  return moved
}

export type MergeCounts = Partial<Record<ProjectTable, number>>

const countsOf = (moved: Moved): MergeCounts => Object.fromEntries(Object.entries(moved).map(([table, ids]) => [table, ids.length]))

/** Points the rows at `into` and drops their vec0 index rows, so the indexer files them under their new project. */
function moveRows(db: Database, moved: Moved, into: string): void {
  for (const [table, ids] of Object.entries(moved) as [ProjectTable, number[]][]) {
    db.query(`UPDATE ${table} SET project_key = $into WHERE rowid IN (SELECT value FROM json_each($ids))`).run({ into, ids: JSON.stringify(ids) })
  }
  if (hasTable(db, 'turn_usage') && moved.sessions !== undefined) {
    db.query('UPDATE turn_usage SET project_key = $into WHERE session_id IN (SELECT value FROM json_each($ids))').run({ into, ids: JSON.stringify(moved.sessions) })
  }
  reindexVectors(db, moved.observations ?? [])
}

/**
 * A vec0 index partitions its rows by project, so moved observations are
 * taken out of each index and the space marked not ready: search scans until
 * the reconcile puts them back under the new project. Without sqlite-vec on
 * this connection there is no index to use, and only the mark is set.
 */
function reindexVectors(db: Database, ids: readonly number[]): void {
  if (ids.length === 0 || !hasTable(db, 'vector_spaces')) return
  const spaces = db.query<{ id: number }, []>('SELECT id FROM vector_spaces').all()
  for (const space of spaces) {
    // The index of space N is vec_space_N (vec-index.ts); it exists only once built.
    if (!hasTable(db, `vec_space_${space.id}`)) continue
    try {
      db.query(`DELETE FROM vec_space_${space.id} WHERE observation_id IN (SELECT value FROM json_each($ids))`).run({ ids: JSON.stringify(ids) })
    } catch {
      // No sqlite-vec on this connection: the reconcile files the rows under their new project once it can (vec-index.ts).
    }
    db.query('UPDATE vector_spaces SET vec_ready = 0 WHERE id = ? AND vec_ready = 1').run(space.id)
  }
}

function clearPacks(db: Database, keys: readonly string[]): void {
  for (const key of keys) db.query('DELETE FROM context_packs WHERE project_key = ?').run(key)
}

function applyMerge(db: Database, from: string, into: string, reason: MergeReason, now: number): MergeCounts {
  const moved = rowsOf(db, from)
  moveRows(db, moved, into)
  db.query('UPDATE projects SET merged_into = $into WHERE key = $from').run({ from, into })
  db.query('INSERT INTO project_merges (from_key, into_key, reason, merged_at, moved) VALUES ($from, $into, $reason, $now, $moved)')
    .run({ from, into, reason, now, moved: JSON.stringify(moved) })
  // Both packs change: stale ones are rebuilt on their next use.
  clearPacks(db, [from, into])
  return countsOf(moved)
}

export type MaintenanceAnswer = { ok: true; dryRun: boolean; from: string; into: string; counts: MergeCounts } | { ok: false; error: string }

const exists = (db: Database, key: string): boolean => db.query<{ n: number }, [string]>('SELECT count(*) AS n FROM projects WHERE key = ?').get(key)?.n === 1

/** `kinfold project merge <from> <into>`: counts first; with dryRun false, one transaction. */
export function mergeProjects(db: Database, from: string, into: string, now: number, options: { dryRun: boolean }): MaintenanceAnswer {
  if (!exists(db, from)) return { ok: false, error: `no project with the key ${from}` }
  if (!exists(db, into)) return { ok: false, error: `no project with the key ${into}` }
  const target = canonicalKey(db, into)
  if (canonicalKey(db, from) === target) return { ok: false, error: `${from} is already ${target}'s memory` }
  if (options.dryRun) return { ok: true, dryRun: true, from, into: target, counts: countsOf(rowsOf(db, from)) }
  const counts = db.transaction(() => applyMerge(db, from, target, 'manual', now))()
  return { ok: true, dryRun: false, from, into: target, counts }
}

interface MergeRecord {
  id: number
  into: string
  moved: string
}

/** `kinfold project split <key>`: the key's latest merge, undone row for row; the key is then held out of automatic merging. */
export function splitProject(db: Database, key: string, now: number, options: { dryRun: boolean }): MaintenanceAnswer {
  const record = db.query<MergeRecord, [string]>('SELECT id, into_key AS "into", moved FROM project_merges WHERE from_key = ? AND split_at IS NULL ORDER BY merged_at DESC, id DESC LIMIT 1').get(key)
  if (record === null) return { ok: false, error: `${key} was not merged into another project` }
  const recorded = JSON.parse(record.moved) as Moved
  // Where the rows are now: the key they were moved to, or where that key was merged since.
  const holders = JSON.stringify([...new Set([record.into, canonicalKey(db, record.into)])])
  // Only rows still there go back: a row purged, or moved again by hand, stays where it is.
  const moved: Moved = {}
  for (const [table, ids] of Object.entries(recorded) as [ProjectTable, number[]][]) {
    if (!hasTable(db, table)) continue
    const still = db.query<{ id: number }, { holders: string; ids: string }>(
      `SELECT rowid AS id FROM ${table} WHERE project_key IN (SELECT value FROM json_each($holders)) AND rowid IN (SELECT value FROM json_each($ids))`,
    ).all({ holders, ids: JSON.stringify(ids) }).map((row) => row.id)
    if (still.length > 0) moved[table] = still
  }
  // What the moved sessions wrote after the merge goes back with them.
  if (moved.sessions !== undefined) {
    const later = db.query<{ id: number }, { holders: string; sessions: string }>(
      `SELECT id FROM observations WHERE project_key IN (SELECT value FROM json_each($holders)) AND session_id IN (SELECT value FROM json_each($sessions))`,
    ).all({ holders, sessions: JSON.stringify(moved.sessions) }).map((row) => row.id)
    if (later.length > 0) moved.observations = [...new Set([...(moved.observations ?? []), ...later])]
  }
  if (options.dryRun) return { ok: true, dryRun: true, from: key, into: record.into, counts: countsOf(moved) }
  db.transaction(() => {
    moveRows(db, moved, key)
    db.query('UPDATE projects SET merged_into = NULL, merge_held = 1 WHERE key = ?').run(key)
    db.query('UPDATE project_merges SET split_at = ? WHERE id = ?').run(now, record.id)
    clearPacks(db, [key, record.into])
  })()
  return { ok: true, dryRun: false, from: key, into: record.into, counts: countsOf(moved) }
}

export interface ProjectListRow {
  key: string
  kind: string
  name: string
  memories: number
  sessions: number
  lastAt: number | null
  mergedInto: string | null
  held: boolean
}

/** Every key, its memory and session counts, most recently active first; merged keys after, with where they went. */
export function listProjects(db: Database): ProjectListRow[] {
  return db.query<Omit<ProjectListRow, 'held'> & { held: number }, []>(
    `SELECT p.key, p.key_kind AS kind, p.display_name AS name, p.merged_into AS mergedInto, p.merge_held AS held,
       (SELECT count(*) FROM observations o WHERE o.project_key = p.key) AS memories,
       (SELECT count(*) FROM sessions s WHERE s.project_key = p.key) AS sessions,
       (SELECT max(last_event_at) FROM sessions s WHERE s.project_key = p.key) AS lastAt
     FROM projects p ORDER BY p.merged_into IS NOT NULL, lastAt DESC, p.key`,
  ).all().map((row) => ({ ...row, held: row.held !== 0 }))
}

export interface RecentMerge extends MergeDone {
  reason: MergeReason
  at: number
}

/** Merges since `since` that still stand, oldest first: what status and watch say once. */
export function recentMerges(db: Database, since: number): RecentMerge[] {
  return db.query<RecentMerge, [number]>(
    `SELECT m.from_key AS fromKey, m.into_key AS intoKey, coalesce(f.display_name, m.from_key) AS "from", coalesce(i.display_name, m.into_key) AS "into", m.reason, m.merged_at AS at
     FROM project_merges m LEFT JOIN projects f ON f.key = m.from_key LEFT JOIN projects i ON i.key = m.into_key
     WHERE m.merged_at >= ? AND m.split_at IS NULL ORDER BY m.merged_at, m.id`,
  ).all(since)
}

/** A folder's first commit, or null when git cannot say (not a repo, gone, or no commits). */
export type RootFor = (cwd: string) => string | null

interface Unrooted {
  key: string
  cwd: string | null
}

/** The folders whose repo backfillRoots asks for, each a project's latest session folder: what a caller can look up ahead of it. */
export function unrootedFolders(db: Database): string[] {
  return [...new Set(unrooted(db).flatMap((row) => (row.cwd === null ? [] : [row.cwd])))]
}

/** Whether the store keeps first commits (v16); the installer reads a store before the daemon migrates it. */
function keepsRoots(db: Database): boolean {
  return db.query<{ name: string }, []>('PRAGMA table_info(projects)').all().some((row) => row.name === 'root_commit')
}

/** A paired device's own key on a hub (central/project-key.ts): its folder is on the device, and the hub must not read its own folder of that name. */
const DEVICE_SCOPED = /^dev-[A-Za-z0-9_-]+:/

function unrooted(db: Database): Unrooted[] {
  const where = keepsRoots(db) ? "p.root_commit IS NULL AND p.key_kind <> 'path' AND p.merged_into IS NULL" : "p.key_kind <> 'path'"
  return db.query<Unrooted, []>(
    `SELECT p.key, (SELECT s.cwd FROM sessions s WHERE s.project_key = p.key ORDER BY s.last_event_at DESC LIMIT 1) AS cwd
     FROM projects p WHERE ${where}`,
  ).all().filter((row) => !DEVICE_SCOPED.test(row.key))
}

/** What backfillRoots would merge, without writing: the install output's dry-run lines. Reads a store from before v16 too. */
export function planRootMerges(db: Database, rootFor: RootFor): MergeDone[] {
  const roots = keepsRoots(db)
  const known = new Map<string, string>()
  for (const row of unrooted(db)) {
    const root = row.cwd === null ? null : rootFor(row.cwd)
    if (root !== null) known.set(row.key, root)
  }
  if (roots) {
    const stored = db.query<{ key: string; root: string }, []>('SELECT key, root_commit AS root FROM projects WHERE root_commit IS NOT NULL AND merged_into IS NULL AND merge_held = 0').all()
    for (const row of stored) known.set(row.key, row.root)
  }
  const byRoot = new Map<string, string[]>()
  for (const [key, root] of known) byRoot.set(root, [...(byRoot.get(root) ?? []), key])
  const all = new Map(db.query<ProjectRow, []>(
    `SELECT p.key, p.key_kind AS kind, p.display_name AS name, (SELECT max(last_event_at) FROM sessions s WHERE s.project_key = p.key) AS lastAt
     FROM projects p${roots ? ' WHERE p.merged_into IS NULL AND p.merge_held = 0' : ''}`,
  ).all().map((row) => [row.key, row]))
  return [...byRoot.values()].filter((keys) => keys.length > 1).flatMap((keys) => {
    const rows = keys.flatMap((key) => all.get(key) ?? [])
    const winner = winnerOf(rows, null)
    return rows.filter((row) => row.key !== winner.key).map((row) => ({ fromKey: row.key, intoKey: winner.key, from: row.name, into: winner.name }))
  })
}

/**
 * Once per store after the upgrade, and for any git key still without a first
 * commit: asks git in the key's most recent session folder, then merges each
 * repo found under two keys. A folder git cannot read is asked again next time.
 */
export function backfillRoots(db: Database, rootFor: RootFor, now: number): MergeDone[] {
  const found = unrooted(db).flatMap((row) => {
    const root = row.cwd === null ? null : rootFor(row.cwd)
    return root === null ? [] : [{ key: row.key, root }]
  })
  if (found.length === 0) return []
  return db.transaction(() => {
    for (const row of found) db.query('UPDATE projects SET root_commit = ? WHERE key = ?').run(row.root, row.key)
    return [...new Set(found.map((row) => row.root))].flatMap((root) => mergeRepo(db, root, null, now))
  })()
}
