// A process the checkpoint crash test kills. It writes rows with the daemon's
// settings (its own connection never checkpoints), starts the checkpoint
// worker, says so on stdout while the worker copies the WAL, and waits to be
// killed. The test passes the data folder as the first argument.

import { SQLITE3MC_LIB_ENV } from '../../src/resources/sqlite/library'
import { openStore } from '../../src/resources/store/db'
import { startCheckpointer } from '../../src/resources/workers/checkpointer'

const dataDir = process.argv[2]
if (dataDir === undefined) throw new Error('pass the data folder')
const rows = Number(process.argv[3] ?? '400')

const store = openStore(dataDir)
store.db.run('PRAGMA wal_autocheckpoint = 0')
store.db.run('CREATE TABLE IF NOT EXISTS bulk (id INTEGER PRIMARY KEY, body BLOB)')
const insert = store.db.prepare('INSERT INTO bulk (body) VALUES ($body)')
store.db.transaction(() => {
  for (let i = 0; i < rows; i += 1) insert.run({ body: new Uint8Array(4_096).fill(i % 251) })
})()
const started = await startCheckpointer({ dbPath: store.path, key: null, libraryOverride: process.env[SQLITE3MC_LIB_ENV] ?? null, intervalMs: 60_000, log: () => {} })
if (!started.ok) throw new Error(started.reason)
void started.checkpointer.checkpointNow()
process.stdout.write('checkpointing\n')
// Killed from here on; nothing below this line is meant to run.
await new Promise(() => {})
