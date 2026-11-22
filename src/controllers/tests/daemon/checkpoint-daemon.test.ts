import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readers } from './daemon'
import { type RunningDaemon, exclusiveOverAll, startDaemon } from './daemon'
import { runNow } from '../vectors/vector-worker'

let root: string
let daemon: RunningDaemon | null
let logs: string[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-checkpoint-daemon-'))
  daemon = null
  logs = []
})
afterEach(async () => {
  await daemon?.stop()
  rmSync(root, { recursive: true, force: true })
})

const waitFor = async (check: () => boolean, ms = 10_000): Promise<void> => {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await Bun.sleep(20)
}

test('the daemon hands checkpoints to the worker and closes it on stop', async () => {
  daemon = startDaemon({ dataDir: join(root, 'data'), port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line) })
  await waitFor(() => logs.some((line) => line.startsWith('checkpoint worker')))
  expect(logs).toContain('checkpoint worker on; the daemon connection no longer checkpoints')
  await daemon.stop()
  daemon = null
  // Closed with its connection: the folder can go at once, Windows included.
  rmSync(join(root, 'data'), { recursive: true, force: true })
})

test('purge, retention and resolve hold the checkpoint worker with the readers', async () => {
  const order: string[] = []
  const reader = (name: string) => ({
    run: async () => undefined as never,
    close: async () => {},
    hold: async () => {
      order.push(`hold ${name}`)
      return () => order.push(`release ${name}`)
    },
  })
  const readers = { recall: reader('recall'), delta: reader('delta'), reports: reader('reports') } as unknown as Readers
  const vectors = { exclusive: runNow } as never
  const holdCheckpoints = async () => {
    order.push('hold checkpoints')
    return () => order.push('release checkpoints')
  }
  await exclusiveOverAll(vectors, readers, holdCheckpoints)(() => order.push('truncate'))
  expect(order.indexOf('hold checkpoints')).toBeLessThan(order.indexOf('truncate'))
  expect(order.indexOf('release checkpoints')).toBeGreaterThan(order.indexOf('truncate'))
})

test('a daemon stopped while its checkpoint worker starts leaves nothing holding the store', async () => {
  const dataDir = join(root, 'data')
  const started = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line) })
  await started.stop()
  // On Windows a handle left open makes this rename fail: the folder move a migration does after stopping a daemon.
  renameSync(dataDir, join(root, 'moved'))
  expect(logs).not.toContain('checkpoint worker on; the daemon connection no longer checkpoints')
})
