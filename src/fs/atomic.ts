// Write a file through a temp file in the same directory, fsync, then rename:
// a reader sees the old file or the new one, never a mix. Kept outside the
// installer so the store and the hook can use it without loading installer
// modules.

import { chmodSync, closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export interface DirSyncOptions {
  /** Default: this process's. Windows cannot open a folder for fsync, so nothing is done there. */
  platform?: NodeJS.Platform
  /** Test seam; default fs.fsyncSync. */
  fsyncDir?: (fd: number) => void
}

export interface AtomicWriteOptions extends DirSyncOptions {
  /** Also fsync the folder after the rename, so the new name survives a power loss. Off by default: most writes can be redone. */
  syncDir?: boolean
}

/** Makes a rename in `dir` durable; the file's own fsync covers only its bytes, not the folder entry. */
export function fsyncDirectory(dir: string, options: DirSyncOptions = {}): void {
  if ((options.platform ?? process.platform) === 'win32') return
  const fd = openSync(dir, 'r')
  try {
    ;(options.fsyncDir ?? fsyncSync)(fd)
  } finally {
    closeSync(fd)
  }
}

export function writeFileAtomic(path: string, content: string | Uint8Array, mode: number, options: AtomicWriteOptions = {}): void {
  const temp = join(dirname(path), `.${basename(path)}.kinfold-tmp-${process.pid}`)
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
  if (options.syncDir === true) fsyncDirectory(dirname(path), options)
}
