// Write a file through a temp file in the same directory, fsync, then rename:
// a reader sees the old file or the new one, never a mix. Kept outside the
// installer so the store and the hook can use it without loading installer
// modules.

import { chmodSync, closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export function writeFileAtomic(path: string, content: string | Uint8Array, mode: number): void {
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
}
