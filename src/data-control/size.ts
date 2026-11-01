// GET /data/size: bytes by table (dbstat when this SQLite has it, else stored
// text lengths), by project for the large tables, the database, WAL and SHM
// file sizes, and whether the total passed the warning threshold the user set.

import { existsSync, statSync } from 'node:fs'
import type { Database } from '../sqlite/types'
import { readDataSettings } from '../store/data-settings-store'
import { type PageInfo, type ProjectBytes, type SizeSource, type TableBytes, pageInfo, projectBytes, tableBytes } from '../store/size-store'

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
  projects: ProjectBytes[]
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
  return {
    ...pages,
    source,
    files,
    totalBytes,
    freeBytes: pages.freelistPages * pages.pageSize,
    warnBytes,
    overWarn: totalBytes >= warnBytes,
    tables,
    projects: projectBytes(db, SIZE_PROJECT_LIMIT),
  }
}
