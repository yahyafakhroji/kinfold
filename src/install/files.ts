// File handling for files the user owns. A JSON file that fails to parse is an
// error and stays untouched; writes go to a temp file in the same directory
// and are renamed over the target, so a crash never leaves half a file; the
// first change to a file is preceded by a 0600 backup of the original. Messages
// carry paths and counts only, never file contents.

import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isRecord } from '../contract/event'

export const BACKUP_INFIX = '.sam-backup-'
const BACKUP_MODE = 0o600

export type JsonFile =
  | { exists: false }
  | { exists: true; value: Readonly<Record<string, unknown>>; text: string; mode: number }

/** Missing is fine; unparseable or not an object throws, and nothing is written. */
export function readJsonObject(path: string): JsonFile {
  if (!existsSync(path)) return { exists: false }
  const text = readFileSync(path, 'utf8')
  let value: unknown
  try {
    value = text.trim() === '' ? {} : JSON.parse(text)
  } catch {
    throw new Error(`${path} is not valid JSON; leaving it untouched`)
  }
  if (!isRecord(value)) throw new Error(`${path} does not hold a JSON object; leaving it untouched`)
  return { exists: true, value, text, mode: statSync(path).mode & 0o777 }
}

/** Two-space JSON, keeping whether the original ended with a newline (a new file gets one). */
export function serializeJson(value: unknown, original: string | null): string {
  const body = JSON.stringify(value, null, 2)
  return original === null || original.endsWith('\n') ? `${body}\n` : body
}

export function readTextOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** Temp file next to the target, fsync, then rename: readers see the old or the new file, never a mix. */
export function writeFileAtomic(path: string, content: string | Uint8Array, mode: number): void {
  const temp = join(dirname(path), `.${basename(path)}.sam-tmp-${process.pid}`)
  const fd = openSync(temp, 'w', mode)
  try {
    if (typeof content === 'string') writeSync(fd, content)
    else writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    chmodSync(temp, mode)
    renameSync(temp, path)
  } catch (error: unknown) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** 20261025T101500Z */
export function backupStamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

export function existingBackups(path: string): string[] {
  const dir = dirname(path)
  if (!existsSync(dir)) return []
  const prefix = `${basename(path)}${BACKUP_INFIX}`
  return readdirSync(dir).filter((name) => name.startsWith(prefix)).map((name) => join(dir, name))
}

/** The backup path the first change would write, or null when a backup already exists or there is no original. */
export function plannedBackup(path: string, now: number): string | null {
  if (!existsSync(path) || existingBackups(path).length > 0) return null
  return `${path}${BACKUP_INFIX}${backupStamp(now)}`
}

export function writeBackup(from: string, to: string): void {
  copyFileSync(from, to)
  chmodSync(to, BACKUP_MODE)
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** "create (4 lines)", "replace (12 -> 14 lines)" or null when nothing changes. */
export function describeTextChange(before: string | null, after: string): string | null {
  if (before === after) return null
  return before === null ? `create (${lineCount(after)} lines)` : `replace (${lineCount(before)} -> ${lineCount(after)} lines)`
}
