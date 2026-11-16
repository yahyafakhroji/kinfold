// A central device keeps its own store as the backup it returns to on leave:
// its daemon changes nothing in it, the vector index's state included.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RunningDaemon, startDaemon } from '../daemon/daemon'
import { openStore } from '../store/db'
import { loadOrCreateKey } from './client'

let root: string
let daemon: RunningDaemon | null
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-device-store-'))
  daemon = null
})
afterEach(async () => {
  await daemon?.stop()
  if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true })
})

test('a device daemon leaves the vector index of its own store as it was', async () => {
  const dataDir = join(root, 'data')
  const store = openStore(dataDir)
  store.db.run("INSERT INTO vector_spaces (model, dims, state, vec_ready, created_at) VALUES ('local-model', 384, 'active', 1, 1)")
  store.db.close()
  loadOrCreateKey(dataDir, 'device-key.pem')
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {}, central: { mode: { role: 'device', hub: '127.0.0.1', port: 1_025, hubName: 'mini', hubPublicKey: `${'A'.repeat(59)}=`, deviceId: 'dev-a', joinedAt: 1 } } })
  await daemon.stop()
  daemon = null
  const after = openStore(dataDir)
  expect(after.db.query('SELECT vec_ready AS ready FROM vector_spaces').all()).toEqual([{ ready: 1 }])
  after.db.close()
})
