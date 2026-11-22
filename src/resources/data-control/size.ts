// GET /data/size: bytes by table (dbstat when this SQLite has it, else stored
// text lengths), by part (prompts, replies, events, observations, summaries,
// vectors, other), by project for the large tables, the database, WAL and SHM
// file sizes, and whether the total passed the warning threshold the user set.
// Past the threshold, the warning names the largest part and the setting that
// trims it.

import { existsSync, statSync } from 'node:fs'
import type { Database } from '../sqlite/types'
import { readDataSettings } from '../store/data-settings-store'
import { type PageInfo, type ProjectBytes, type PromptTextBytes, type SizeSource, type TableBytes, pageInfo, projectBytes, promptTextBytes, tableBytes } from '../store/size-store'

export const SIZE_PROJECT_LIMIT = 50

export interface FileSizes {
  db: number
  wal: number
  shm: number
}

export interface SizeReport extends PageInfo {
  source: SizeSource
  files: FileSizes
  /** db + wal: what the store occupies on disk now. */
  totalBytes: number
  /** Pages incremental_vacuum would hand back. */
  freeBytes: number
  warnBytes: number
  overWarn: boolean
  tables: TableBytes[]
  /** Adds up to totalBytes; other holds the WAL, free pages and the small tables. */
  parts: SizePart[]
  /** Set while overWarn: the largest part, its share and the setting that trims it. */
  warning: string | null
  projects: ProjectBytes[]
}

export type SizePartName = 'prompts' | 'replies' | 'events' | 'observations' | 'summaries' | 'vectors' | 'other'

export interface SizePart {
  name: SizePartName
  bytes: number
}

/** Tables each part owns. Prompts and replies share the prompts table and split it by text length. */
const PART_TABLES: readonly (readonly [Exclude<SizePartName, 'prompts' | 'replies' | 'other'>, readonly string[]])[] = [
  ['events', ['events']],
  ['observations', ['observations', 'observations_fts']],
  ['summaries', ['summaries']],
  ['vectors', ['observation_vectors']],
]

/** The retention setting that trims each part; vectors go with their observation. */
const TRIMMED_BY: Readonly<Record<Exclude<SizePartName, 'other'>, string>> = {
  prompts: 'prompts',
  replies: 'prompts',
  events: 'events',
  observations: 'observations',
  summaries: 'summaries',
  vectors: 'observations',
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function sizeParts(tables: readonly TableBytes[], prompts: PromptTextBytes, totalBytes: number): SizePart[] {
  const bytesOf = (names: readonly string[]): number => tables.filter((table) => names.includes(table.name)).reduce((sum, table) => sum + table.bytes, 0)
  const promptTable = bytesOf(['prompts'])
  const text = prompts.text + prompts.reply
  const replies = text === 0 ? 0 : Math.round((promptTable * prompts.reply) / text)
  const named: SizePart[] = [
    { name: 'prompts', bytes: promptTable - replies },
    { name: 'replies', bytes: replies },
    ...PART_TABLES.map(([name, owned]) => ({ name, bytes: bytesOf(owned) })),
  ]
  const used = named.reduce((sum, part) => sum + part.bytes, 0)
  return [...named, { name: 'other', bytes: Math.max(0, totalBytes - used) }]
}

export function sizeWarning(parts: readonly SizePart[], totalBytes: number): string {
  const largest = parts.reduce((best, part) => (part.bytes > best.bytes ? part : best), parts[0] ?? { name: 'other', bytes: 0 })
  const share = totalBytes === 0 ? 0 : Math.round((largest.bytes / totalBytes) * 100)
  const of = `${share}% of ${formatBytes(totalBytes)}`
  if (largest.name === 'other') return `other data is ${of}; no retention setting trims it`
  return `${largest.name} are ${of}; set ${TRIMMED_BY[largest.name]} retention to trim them`
}

function fileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

export function fileSizes(dbPath: string): FileSizes {
  return { db: fileSize(dbPath), wal: fileSize(`${dbPath}-wal`), shm: fileSize(`${dbPath}-shm`) }
}

export function sizeReport(db: Database, dbPath: string): SizeReport {
  const pages = pageInfo(db)
  const files = fileSizes(dbPath)
  const { source, tables } = tableBytes(db)
  const { warnBytes } = readDataSettings(db)
  const totalBytes = files.db + files.wal
  const overWarn = totalBytes >= warnBytes
  const parts = sizeParts(tables, promptTextBytes(db), totalBytes)
  return {
    ...pages,
    source,
    files,
    totalBytes,
    freeBytes: pages.freelistPages * pages.pageSize,
    warnBytes,
    overWarn,
    tables,
    parts,
    warning: overWarn ? sizeWarning(parts, totalBytes) : null,
    projects: projectBytes(db, SIZE_PROJECT_LIMIT),
  }
}
