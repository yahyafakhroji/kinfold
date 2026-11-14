// The backup's snapshot, off the daemon's main thread: one message in (the
// store path, its key, the destination), one copy, one message out. The key
// arrives in the start message (in-process memory only) and is never logged
// or put in a reply; a failure answers the error's name or a BackupError's
// fixed text.

import { BackupError } from './archive'
import { type SnapshotWorkerInput, type SnapshotWorkerReply, snapshotStoreFile, workerEnv } from './snapshot'

declare const self: Worker

function run(input: SnapshotWorkerInput): SnapshotWorkerReply {
  try {
    snapshotStoreFile({ dbPath: input.dbPath, key: input.key, dest: input.dest, env: workerEnv(input.libraryOverride) })
    return { ok: true }
  } catch (error: unknown) {
    if (error instanceof BackupError) return { ok: false, reason: error.message }
    return { ok: false, reason: `the snapshot could not be written (${error instanceof Error ? error.name : 'error'})` }
  }
}

self.onmessage = (event: MessageEvent<SnapshotWorkerInput>) => {
  self.postMessage(run(event.data))
}
