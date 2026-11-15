// <dataDir>/auto-update.lock: one update at a time, whether the daemon
// started it or the user typed `kinfold update`. The file holds the pid of
// the run that owns it and when that run took it. A run that was killed
// cannot remove its lock, so a lock whose pid is gone is taken over rather
// than left to block every later update. So is one older than any update
// lasts: after a power loss the pid in the file can belong to an unrelated
// process, and a lock that trusted it would never be released.

import { closeSync, linkSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_FILE_MODE } from '../store/data-dir'

export const UPDATE_LOCK_FILE = 'auto-update.lock'
/** Far longer than an update takes: the download gives up after five minutes and the install after fifteen. */
export const LOCK_MAX_AGE_MS = 3_600_000

export interface UpdateLockDeps {
  /** Default: this process's. */
  pid?: number
  /** Default: signal 0 to the pid. */
  alive?: (pid: number) => boolean
  /** Default: Date.now. */
  now?: () => number
  /** Test seam; default fs.linkSync. */
  link?: (from: string, to: string) => void
}

export interface UpdateLock {
  /** Removes the lock when this run still owns it. */
  release(): void
}

/** EPERM means the pid exists under another user, so only ESRCH counts as gone. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

interface Written {
  pid: number
  takenAt: number
}

/** What the file names; null when it is missing or is anything but a pid line and a time line. */
function written(dataDir: string, file: string = UPDATE_LOCK_FILE): Written | null {
  try {
    const [pidText = '', timeText = ''] = readFileSync(join(dataDir, file), 'utf8').split('\n')
    if (!/^\d+$/.test(pidText) || !/^\d+$/.test(timeText)) return null
    const pid = Number(pidText)
    const takenAt = Number(timeText)
    return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(takenAt) ? { pid, takenAt } : null
  } catch {
    return null
  }
}

/** The live run that owns the lock; null when there is none, including a lock left by a run that is gone or one too old to be an update. */
export function updateLockHolder(dataDir: string, alive: (pid: number) => boolean = pidAlive, now: number = Date.now()): number | null {
  const lock = written(dataDir)
  if (lock === null || now - lock.takenAt > LOCK_MAX_AGE_MS) return null
  return alive(lock.pid) ? lock.pid : null
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

/**
 * The content is written to a temp file first and linked into place, so the
 * file never exists without its pid: an empty lock would look like one left by
 * a dead run, and a second update would take it over mid-write. A folder that
 * cannot hold a hard link (exFAT, some network mounts) gets an exclusive
 * create instead, which leaves that short window but still admits one owner.
 */
function tryCreate(path: string, content: string, pid: number, link: (from: string, to: string) => void): boolean {
  const temp = `${path}.${pid}`
  writeFileSync(temp, content, { mode: DATA_FILE_MODE })
  try {
    link(temp, path)
    return true
  } catch (error: unknown) {
    if (errorCode(error) === 'EEXIST') return false
    return createExclusive(path, content)
  } finally {
    rmSync(temp, { force: true })
  }
}

function createExclusive(path: string, content: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx', DATA_FILE_MODE)
  } catch (error: unknown) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  }
  try {
    writeSync(fd, content)
  } finally {
    closeSync(fd)
  }
  return true
}

export const TAKEOVER_CLAIM_FILE = `${UPDATE_LOCK_FILE}.takeover`
/** A takeover lasts milliseconds; a claim this old was left by a run that died in the middle of one. */
export const TAKEOVER_CLAIM_MAX_AGE_MS = 30_000

/**
 * The right to remove a dead lock, held by one run at a time. Without it two
 * runs could each see the dead lock, each remove what was there (the second
 * removing the first's fresh lock) and each create their own. A claim left by
 * a run that died is cleared here, but this call still steps back: two runs
 * that both cleared it must not both go on, and the next attempt finds it gone.
 */
function claimTakeover(dataDir: string, content: string, pid: number, now: number, link: (from: string, to: string) => void): boolean {
  const path = join(dataDir, TAKEOVER_CLAIM_FILE)
  if (tryCreate(path, content, pid, link)) return true
  const claim = written(dataDir, TAKEOVER_CLAIM_FILE)
  if (claim === null || now - claim.takenAt > TAKEOVER_CLAIM_MAX_AGE_MS) rmSync(path, { force: true })
  return false
}

/** The lock, or null while another live run holds it or is taking a dead one over. */
export function acquireUpdateLock(dataDir: string, deps: UpdateLockDeps = {}): UpdateLock | null {
  const pid = deps.pid ?? process.pid
  const alive = deps.alive ?? pidAlive
  const now = (deps.now ?? Date.now)()
  const link = deps.link ?? linkSync
  const path = join(dataDir, UPDATE_LOCK_FILE)
  const content = `${pid}\n${now}\n`
  const heldByAnother = (): boolean => {
    const holder = updateLockHolder(dataDir, alive, now)
    return holder !== null && holder !== pid
  }
  if (!tryCreate(path, content, pid, link)) {
    if (heldByAnother() || !claimTakeover(dataDir, content, pid, now, link)) return null
    try {
      // Looked at again under the claim: a run that held the claim a moment ago may have just made this lock.
      if (heldByAnother()) return null
      rmSync(path, { force: true })
      if (!tryCreate(path, content, pid, link)) return null
    } finally {
      rmSync(join(dataDir, TAKEOVER_CLAIM_FILE), { force: true })
    }
  }
  return {
    release(): void {
      if (written(dataDir)?.pid === pid) rmSync(path, { force: true })
    },
  }
}
