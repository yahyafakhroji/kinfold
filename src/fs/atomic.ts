// Write a file through a temp file in the same directory, fsync, then rename:
// a reader sees the old file or the new one, never a mix. Kept outside the
// installer so the store and the hook can use it without loading installer
// modules.

import { chmodSync, closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { currentPlatform, osOf } from '../platform/platform'

export interface DirSyncOptions {
  /** Default: this process's. Windows cannot open a folder for fsync, so nothing is done there. */
  platform?: NodeJS.Platform
  /** Test seam; default fs.fsyncSync. */
  fsyncDir?: (fd: number) => void
}

export interface AtomicWriteOptions extends DirSyncOptions {
  /** Also fsync the folder after the rename, so the new name survives a power loss. Off by default: most writes can be redone. */
  syncDir?: boolean
  /** Test seam: the write to the temp file. */
  write?: (fd: number, content: string | Uint8Array) => number
}

/** Makes a rename in `dir` durable; the file's own fsync covers only its bytes, not the folder entry. */
export function fsyncDirectory(dir: string, options: DirSyncOptions = {}): void {
  if (osOf(options.platform ?? currentPlatform().node) === 'windows') return
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
  // Whatever fails before the rename (a full disk in the write, an I/O error in the fsync), the temp file goes with
  // it: its name holds this pid, so no other process would ever replace it, and it can hold a secret at mode 0600.
  try {
    try {
      const write = options.write ?? ((target: number, data: string | Uint8Array): number => (typeof data === 'string' ? writeSync(target, data) : writeSync(target, data)))
      write(fd, content)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(temp, mode)
    renameSync(temp, path)
  } catch (error: unknown) {
    rmSync(temp, { force: true })
    throw error
  }
  if (options.syncDir === true) fsyncDirectory(dirname(path), options)
}
