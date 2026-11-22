// Disk spool between the capture CLI and the daemon. Entries are written to a
// temp file and renamed, so the daemon never reads a half-written event, and
// every file is owner-only because it holds tool output.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { RedactedEvent } from '../capture/prepare'
import { type NormalizedEvent, validateEvent } from '../contract/event'

export const DIR_MODE = 0o700
export const FILE_MODE = 0o600
export const QUARANTINE_DIR = 'quarantine'

const ENTRY_NAME = /^\d{13}-[0-9A-HJKMNP-TV-Z]{26}\.json$/

export interface SpoolEntry {
  path: string
  event: NormalizedEvent
}

export interface QuarantinedEntry {
  path: string
  reason: string
}

export interface SpoolRead {
  entries: SpoolEntry[]
  quarantined: QuarantinedEntry[]
}

/** Sorting by name sorts by host event time, then by ULID. */
export function entryFileName(event: NormalizedEvent): string {
  return `${String(event.occurredAt).padStart(13, '0')}-${event.eventId}.json`
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  chmodSync(dir, DIR_MODE)
}

/** Accepts only RedactedEvent, so an event that skipped the edge pipeline does not compile. */
export function writeSpoolEntry(dir: string, event: RedactedEvent): string {
  const check = validateEvent(event)
  if (!check.ok) throw new Error(`refusing to spool an invalid event: ${check.errors.join('; ')}`)

  ensureDir(dir)
  const finalPath = join(dir, entryFileName(event))
  const tempPath = join(dir, `.tmp-${event.eventId}`)
  const fd = openSync(tempPath, 'wx', FILE_MODE)
  try {
    writeSync(fd, JSON.stringify(event))
    fsyncSync(fd)
  } catch (error: unknown) {
    closeSync(fd)
    rmSync(tempPath, { force: true })
    throw error
  }
  closeSync(fd)
  renameSync(tempPath, finalPath)
  return finalPath
}

function parseEntry(path: string): { event: NormalizedEvent } | { reason: string } {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error: unknown) {
    return { reason: `unreadable JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const check = validateEvent(raw)
  return check.ok ? { event: check.event } : { reason: check.errors.join('; ') }
}

function quarantine(dir: string, name: string): string {
  const target = join(dir, QUARANTINE_DIR)
  ensureDir(target)
  const destination = join(target, name)
  renameSync(join(dir, name), destination)
  return destination
}

/** Oldest first. Entries that fail to parse or validate move to quarantine and are reported. */
export function readSpool(dir: string, limit: number = Number.POSITIVE_INFINITY): SpoolRead {
  if (!existsSync(dir)) return { entries: [], quarantined: [] }
  const entries: SpoolEntry[] = []
  const quarantined: QuarantinedEntry[] = []

  for (const name of readdirSync(dir).filter((file) => ENTRY_NAME.test(file)).sort()) {
    if (entries.length >= limit) break
    const path = join(dir, name)
    const parsed = parseEntry(path)
    if ('event' in parsed) entries.push({ path, event: parsed.event })
    else quarantined.push({ path: quarantine(dir, name), reason: parsed.reason })
  }
  return { entries, quarantined }
}

export interface SpoolCursor {
  /** The next entries, oldest first, up to `limit`; `more` is false once a listing has been used up. */
  next(limit: number): SpoolRead & { more: boolean }
  /** Forgets the listing, so entries handed out but still on disk (a batch that did not commit) are read again. */
  reset(): void
}

export function listEntries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((file) => ENTRY_NAME.test(file)).sort() : []
}

/**
 * readSpool in batches over one listing: the directory is listed and sorted
 * only when the names from the last listing are used up, so a backlog of N
 * files costs one listing, not one per batch. Entries written meanwhile are
 * found by the next listing.
 */
export function createSpoolCursor(dir: string, list: (dir: string) => string[] = listEntries): SpoolCursor {
  let names: string[] = []
  let at = 0
  return {
    next: (limit) => {
      if (at >= names.length) {
        names = list(dir)
        at = 0
      }
      const entries: SpoolEntry[] = []
      const quarantined: QuarantinedEntry[] = []
      while (at < names.length && entries.length < limit) {
        const name = names[at]!
        at += 1
        const path = join(dir, name)
        // Listed a while ago: an entry removed since then is neither read nor quarantined.
        if (!existsSync(path)) continue
        const parsed = parseEntry(path)
        if ('event' in parsed) entries.push({ path, event: parsed.event })
        else quarantined.push({ path: quarantine(dir, name), reason: parsed.reason })
      }
      return { entries, quarantined, more: at < names.length }
    },
    reset: () => {
      names = []
      at = 0
    },
  }
}

/** Moves one entry into quarantine, beside the ones readSpool set aside; it is never read again. */
export function quarantineSpoolEntry(path: string): string {
  return quarantine(dirname(path), basename(path))
}

/** How many entries wait, by file name alone: nothing is read or parsed. */
export function countSpool(dir: string): number {
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter((file) => ENTRY_NAME.test(file)).length
}

export function removeSpoolEntry(path: string): void {
  rmSync(path, { force: true })
}
