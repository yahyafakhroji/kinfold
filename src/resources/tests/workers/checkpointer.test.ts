import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type TempStore, openTempStore } from '../observer/test-support'
import { SQLITE3MC_LIB_ENV } from '../../sqlite/library'
import { openStore } from '../../store/db'
import { type Checkpointer, startCheckpointer } from '../../workers/checkpointer'

let temp: TempStore
let checkpointer: Checkpointer | null
beforeEach(() => {
  temp = openTempStore('kinfold-checkpointer-')
  // As the daemon's connection runs once the worker is up: it never checkpoints itself.
  temp.store.db.run('PRAGMA wal_autocheckpoint = 0')
  temp.store.db.run('CREATE TABLE IF NOT EXISTS bulk (id INTEGER PRIMARY KEY, body BLOB)')
  checkpointer = null
})
afterEach(async () => {
  await checkpointer?.close()
  temp.cleanup()
})

const walPath = (): string => `${temp.store.path}-wal`
const walBytes = (): number => (existsSync(walPath()) ? statSync(walPath()).size : 0)
const write = (rows: number, bytes = 4_096): void => {
  const insert = temp.store.db.prepare('INSERT INTO bulk (body) VALUES ($body)')
  temp.store.db.transaction(() => {
    for (let i = 0; i < rows; i += 1) insert.run({ body: new Uint8Array(bytes).fill(i % 251) })
  })()
}

async function started(options: Partial<Parameters<typeof startCheckpointer>[0]> = {}): Promise<Checkpointer> {
  const result = await startCheckpointer({ dbPath: temp.store.path, key: null, libraryOverride: process.env[SQLITE3MC_LIB_ENV] ?? null, intervalMs: 60_000, log: () => {}, ...options })
  if (!result.ok) throw new Error(result.reason)
  checkpointer = result.checkpointer
  return result.checkpointer
}

test('the worker copies the WAL into the store on its own connection', async () => {
  const worker = await started()
  write(200)
  const result = await worker.checkpointNow()
  expect(result).toMatchObject({ busy: 0 })
  expect(result!.log).toBeGreaterThan(0)
  expect(result!.checkpointed).toBe(result!.log)
})

test('a WAL past the limit is truncated once every frame is in the store', async () => {
  const worker = await started({ truncateBytes: 64 * 1024 })
  write(200)
  expect(walBytes()).toBeGreaterThan(64 * 1024)
  await worker.checkpointNow()
  expect(walBytes()).toBe(0)
  expect((temp.store.db.query('SELECT count(*) AS n FROM bulk').get() as { n: number }).n).toBe(200)
})

test('a hold waits for the checkpoint in flight and keeps the next one back until it is released', async () => {
  const worker = await started()
  write(50)
  const release = await worker.hold()
  let ran = false
  const later = worker.checkpointNow().then((result) => {
    ran = true
    return result
  })
  await Bun.sleep(50)
  expect(ran).toBe(false)
  release()
  expect(await later).toMatchObject({ busy: 0 })
})

test('busy is true while a checkpoint is in flight, and false while one waits on a hold or has answered', async () => {
  const worker = await started()
  write(200)
  expect(worker.busy()).toBe(false)
  const release = await worker.hold()
  const done = worker.checkpointNow()
  // Microtasks only: the worker's answer is a message, so it cannot land inside this loop.
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  expect(worker.busy()).toBe(false)
  release()
  for (let i = 0; i < 1_000 && !worker.busy(); i += 1) await Promise.resolve()
  expect(worker.busy()).toBe(true)
  expect(await done).toMatchObject({ busy: 0 })
  expect(worker.busy()).toBe(false)
})

test('the timer checkpoints on its own, and close stops it', async () => {
  const worker = await started({ intervalMs: 20 })
  write(100)
  for (let i = 0; i < 50 && (worker.lastResult()?.checkpointed ?? 0) === 0; i += 1) await Bun.sleep(20)
  expect(worker.lastResult()?.checkpointed).toBeGreaterThan(0)
  await worker.close()
  expect(await worker.checkpointNow()).toBeNull()
})

test('a process killed in the middle of a checkpoint loses nothing: the WAL is replayed at the next open', async () => {
  // A whole process, as a crash takes one: the system then lets go of every file it held, Windows included.
  const dataDir = join(temp.root, 'crashed')
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', '..', '..', '..', 'test', 'fixtures', 'checkpoint-crash.ts'), dataDir, '400'], { stdout: 'pipe', stderr: 'pipe', env: process.env })
  const reader = child.stdout.getReader()
  let seen = ''
  while (!seen.includes('checkpointing')) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`the writer exited before its checkpoint: ${await new Response(child.stderr).text()}`)
    seen += new TextDecoder().decode(value)
  }
  child.kill('SIGKILL')
  await child.exited
  const reopened = openStore(dataDir)
  try {
    expect((reopened.db.query('SELECT count(*) AS n FROM bulk').get() as { n: number }).n).toBe(400)
    expect((reopened.db.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
  } finally {
    reopened.db.close()
  }
  // Nothing of the killed process holds the files.
  rmSync(dataDir, { recursive: true, force: true })
  expect(existsSync(dataDir)).toBe(false)
})

test('a store the worker cannot open is reported, and nothing is left running', async () => {
  const result = await startCheckpointer({ dbPath: join(temp.root, 'missing', 'memory.db'), key: null, libraryOverride: null, intervalMs: 60_000, log: () => {} })
  expect(result.ok).toBe(false)
})
