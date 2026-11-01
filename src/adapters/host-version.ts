// host_version without a process spawn on the hook hot path. Cursor puts
// cursor_version on every payload and OpenCode puts data.version on
// session.created; Claude Code and Codex carry no version at all. For those,
// `kinfold install` records what `<host> --version` answered, plus the mtime of
// the binary it resolved, in <dataDir>/host-versions.json. A hook reads that
// file (one read, one stat) and trusts it only while it is fresh:
//   - a binary was stamped: fresh while that file still has the same mtime
//     (an upgrade replaces the binary, so the version goes unknown, not wrong);
//   - no binary could be stamped: fresh for UNPINNED_MAX_AGE_MS after install.
// A stale or missing record means no hostVersion; rerunning install refreshes it.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../contract/event'

export const HOST_VERSIONS_FILE = 'host-versions.json'
export const HOST_VERSIONS_SCHEMA = 1
export const UNPINNED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface BinaryStamp {
  path: string
  mtimeMs: number
}

export interface HostVersionRecord {
  version: string
  recordedAt: number
  binary: BinaryStamp | null
}

export type HostVersionRecords = Readonly<Record<string, HostVersionRecord>>

/** mtime in ms, or null when the path is gone or unreadable. */
export type MtimeReader = (path: string) => number | null

const SEMVER = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/

/** "2.1.310 (Claude Code)", "codex-cli 0.120.0", "opencode v2.1.4" -> the first x.y.z, or null. */
export function normalizeVersion(raw: string): string | null {
  return SEMVER.exec(raw)?.[0] ?? null
}

function parseStamp(value: unknown): BinaryStamp | null | undefined {
  if (value === null) return null
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.mtimeMs !== 'number') return undefined
  return { path: value.path, mtimeMs: value.mtimeMs }
}

function parseRecord(value: unknown): HostVersionRecord | null {
  if (!isRecord(value) || typeof value.version !== 'string' || !Number.isSafeInteger(value.recordedAt)) return null
  const binary = parseStamp(value.binary)
  if (binary === undefined) return null
  return { version: value.version, recordedAt: value.recordedAt as number, binary }
}

/** Drops any entry it cannot read; a wrong schema version reads as empty. */
export function parseHostVersions(value: unknown): HostVersionRecords {
  if (!isRecord(value) || value.schemaVersion !== HOST_VERSIONS_SCHEMA || !isRecord(value.hosts)) return {}
  const entries = Object.entries(value.hosts).flatMap(([host, entry]) => {
    const record = parseRecord(entry)
    return record === null ? [] : [[host, record] as const]
  })
  return Object.fromEntries(entries)
}

export function serializeHostVersions(records: HostVersionRecords): string {
  return `${JSON.stringify({ schemaVersion: HOST_VERSIONS_SCHEMA, hosts: records }, null, 2)}\n`
}

export const statMtime: MtimeReader = (path) => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

export function isStale(record: HostVersionRecord, now: number, mtimeOf: MtimeReader = statMtime): boolean {
  if (record.binary !== null) return mtimeOf(record.binary.path) !== record.binary.mtimeMs
  return now - record.recordedAt > UNPINNED_MAX_AGE_MS
}

export function readHostVersions(dataDir: string): HostVersionRecords {
  try {
    return parseHostVersions(JSON.parse(readFileSync(join(dataDir, HOST_VERSIONS_FILE), 'utf8')))
  } catch {
    return {}
  }
}

/** The recorded version while it is fresh; undefined otherwise. Never throws. */
export function recordedHostVersion(dataDir: string, host: string, now: number = Date.now(), mtimeOf: MtimeReader = statMtime): string | undefined {
  const record = readHostVersions(dataDir)[host]
  if (record === undefined || isStale(record, now, mtimeOf)) return undefined
  return record.version
}
