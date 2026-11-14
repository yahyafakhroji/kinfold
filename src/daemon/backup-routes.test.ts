import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readArchive } from '../backup/archive'
import { BACKUP_TMP_DIR, createBackup } from '../backup/create'
import { readBackupRecord } from '../backup/record'
import { applyRestore, inspectBackup, replacedPath, stageSnapshot } from '../backup/restore'
import { snapshotInto } from '../backup/snapshot'
import { type DashboardRig, startRig } from '../dashboard/test-support'
import { type RecordingKeyStore, recordingKeyStore } from '../install/test-support'
import { PROJECT_A, seedMcpObservation, seedMcpSession } from '../mcp/test-support'
import { DB_KEY_REF, DB_KEY_REPLACED_REF } from '../secrets/credentials'
import type { KeyStore } from '../secrets/key-store'
import { dbKeyStoreOf, newDbKey } from '../sqlite/keys'
import { maintenancePath, openPlain } from '../sqlite/open'
import { encodeRecoveryCode } from '../sqlite/recovery'
import { DB_FILE } from '../store/data-dir'
import { openStore } from '../store/db'
import { LATEST_SCHEMA_VERSION } from '../store/schema'
import { RESTORE_INCOMING_DIR } from './backup-routes'
import type { DaemonOptions } from './daemon'

let root: string
let rigs: DashboardRig[]
let serial = 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kf-backup-routes-'))
  rigs = []
})
afterEach(async () => {
  for (const rig of rigs) await rig.stop().catch(() => {})
  rmSync(root, { recursive: true, force: true })
})

interface Box {
  rig: DashboardRig
  dataDir: string
  keyStore: RecordingKeyStore
  key: string | null
}

function seedStore(dataDir: string, key: string | null, keyStore: KeyStore, titles: readonly string[]): void {
  const store = openStore(dataDir, { keys: dbKeyStoreOf(key === null ? null : keyStore) })
  for (const title of titles) {
    const session = seedMcpSession(store, PROJECT_A, 'claude-code', `session-${title}`)
    seedMcpObservation(store, { projectKey: PROJECT_A, sessionId: session, title, at: 1_790_000_000_000 })
  }
  store.db.close()
}

/** A daemon over its own data folder and key store, with a store holding `titles`. */
function box(options: { encrypted?: boolean; titles?: string[]; backup?: DaemonOptions['backup']; keyStore?: RecordingKeyStore } = {}): Box {
  serial += 1
  const dataDir = join(root, `data-${serial}`)
  const keyStore = options.keyStore ?? recordingKeyStore()
  const key = options.encrypted === false ? null : newDbKey()
  if (key !== null) keyStore.set(DB_KEY_REF, key)
  seedStore(dataDir, key, keyStore, options.titles ?? [])
  const rig = startRig(dataDir, { dbKeys: dbKeyStoreOf(keyStore), keyStore, ...(options.backup !== undefined ? { backup: options.backup } : {}) })
  rigs.push(rig)
  return { rig, dataDir, keyStore, key }
}

/** A backup file made outside any daemon, from a store holding `titles`. */
async function backupFile(options: { encrypted?: boolean; titles?: string[]; claimSchema?: number } = {}): Promise<{ file: string; key: string | null }> {
  serial += 1
  const dataDir = join(root, `source-${serial}`)
  const keyStore = recordingKeyStore()
  const key = options.encrypted === false ? null : newDbKey()
  if (key !== null) keyStore.set(DB_KEY_REF, key)
  seedStore(dataDir, key, keyStore, options.titles ?? ['from the backup'])
  const store = openStore(dataDir, { keys: dbKeyStoreOf(key === null ? null : keyStore) })
  const file = join(root, `backup-${serial}.kfb`)
  await createBackup({
    dataDir,
    dest: file,
    snapshot: (path) => {
      const version = snapshotInto(store.db, path)
      return options.claimSchema ?? version
    },
    version: '0.2.0',
    now: () => 1_794_000_000_000,
  })
  store.db.close()
  return { file, key }
}

const bearer = (rig: DashboardRig): Record<string, string> => ({ authorization: `Bearer ${rig.token}` })

function upload(rig: DashboardRig, body: string | Uint8Array, headers: Record<string, string> = bearer(rig)): Promise<Response> {
  return fetch(rig.url('/restore/upload'), { method: 'POST', headers, body })
}

async function uploaded(rig: DashboardRig, file: string): Promise<string> {
  const response = await upload(rig, readFileSync(file))
  expect(response.status).toBe(200)
  return ((await response.json()) as { upload: string }).upload
}

interface Status {
  state: string
  step: string | null
  lines: string[]
  error: string | null
}

async function statusOf(rig: DashboardRig): Promise<Status> {
  return (await (await rig.bearer('GET', '/restore/status')).json()) as Status
}

async function settled(rig: DashboardRig): Promise<Status> {
  for (let tries = 0; tries < 400; tries += 1) {
    const status = await statusOf(rig)
    if (status.state !== 'running') return status
    await Bun.sleep(10)
  }
  throw new Error('the restore did not settle')
}

async function titlesOver(rig: DashboardRig, headers: Record<string, string> = bearer(rig)): Promise<string> {
  const response = await fetch(rig.url('/memory/observations'), { headers })
  expect(response.status).toBe(200)
  return response.text()
}

test('GET /backup downloads a backup that restores elsewhere, as an attachment that is never cached', async () => {
  const { rig, dataDir, key } = box({ titles: ['kept safe'] })
  const response = await rig.bearer('GET', '/backup')
  expect(response.status).toBe(200)
  expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="kinfold-backup-\d{4}-\d{2}-\d{2}\.kfb"$/)
  expect(response.headers.get('content-type')).toBe('application/octet-stream')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  const bytes = Buffer.from(await response.arrayBuffer())
  const file = join(root, 'downloaded.kfb')
  writeFileSync(file, bytes)
  const header = inspectBackup(file)
  expect(header.manifest).toMatchObject({ encrypted: true, schemaVersion: LATEST_SCHEMA_VERSION })
  expect(bytes.includes(Buffer.from(key!))).toBe(false)
  expect(bytes.includes(Buffer.from(rig.token))).toBe(false)

  const elsewhere = join(root, 'elsewhere')
  const keyStore = recordingKeyStore()
  const staged = await stageSnapshot({ dataDir: elsewhere, archivePath: file, header, key })
  await applyRestore({ dataDir: elsewhere, staged, keyStore, log: () => {}, sleep: async () => {} })
  const restored = openStore(elsewhere, { keys: dbKeyStoreOf(keyStore) })
  expect(restored.db.query<{ title: string }, []>('SELECT title FROM observations').get()!.title).toBe('kept safe')
  restored.db.close()

  expect(readdirSync(join(dataDir, BACKUP_TMP_DIR))).toEqual([])
  expect(readBackupRecord(dataDir)).not.toBeNull()
  expect(rig.logs.join('\n')).not.toContain(key!)
})

test('the download takes the dashboard cookie too, and nothing without a credential', async () => {
  const { rig } = box({ titles: ['one'] })
  expect((await fetch(rig.url('/backup'))).status).toBe(401)
  const cookie = await rig.login()
  const response = await rig.page('GET', '/backup', { cookie, bare: true })
  expect(response.status).toBe(200)
  await response.arrayBuffer()
  expect((await rig.bearer('POST', '/backup')).status).toBe(405)
})

test('the daemon keeps answering while it writes a backup', async () => {
  const { rig } = box({ titles: ['one'] })
  const [backup, health] = await Promise.all([rig.bearer('GET', '/backup'), fetch(rig.url('/health'))])
  expect(health.status).toBe(200)
  expect(backup.status).toBe(200)
  await backup.arrayBuffer()
})

test('an upload is streamed to an owner-only file in the data folder and answered with what the manifest says', async () => {
  const { rig, dataDir } = box()
  const { file } = await backupFile()
  const response = await upload(rig, readFileSync(file))
  expect(response.status).toBe(200)
  const body = (await response.json()) as { upload: string; manifest: Record<string, unknown> }
  expect(body.upload).toMatch(/^[0-9a-f]{32}$/)
  expect(body.manifest).toEqual({ createdAt: 1_794_000_000_000, kinfoldVersion: '0.2.0', schemaVersion: LATEST_SCHEMA_VERSION, encrypted: true, bytes: readArchive(file).manifest.snapshot.bytes })
  const incoming = join(dataDir, RESTORE_INCOMING_DIR)
  const [name] = readdirSync(incoming)
  expect(readFileSync(join(incoming, name!)).equals(readFileSync(file))).toBe(true)
  if (process.platform !== 'win32') {
    expect(statSync(join(incoming, name!)).mode & 0o777).toBe(0o600)
    expect(statSync(incoming).mode & 0o777).toBe(0o700)
  }
  // A second upload replaces the first: one pending file at most.
  await uploaded(rig, file)
  expect(readdirSync(incoming)).toHaveLength(1)
})

test('an upload that is not a backup, or is from a newer Kinfold, is refused and removed', async () => {
  const { rig, dataDir } = box()
  const junk = await upload(rig, 'this is not a backup file, only some text that is long enough')
  expect(junk.status).toBe(400)
  expect(((await junk.json()) as { error: string }).error).toContain('not a Kinfold backup')
  const { file } = await backupFile({ claimSchema: LATEST_SCHEMA_VERSION + 3 })
  const newer = await upload(rig, readFileSync(file))
  expect(newer.status).toBe(400)
  expect(((await newer.json()) as { error: string }).error).toContain(`schema ${LATEST_SCHEMA_VERSION + 3}`)
  expect(readdirSync(join(dataDir, RESTORE_INCOMING_DIR))).toEqual([])
  expect((await statusOf(rig)).state).toBe('idle')
})

test('the upload limit is enforced by counting, whatever the request declares', async () => {
  const { rig, dataDir } = box({ backup: { uploadLimit: () => 4_000 } })
  const declared = await upload(rig, new Uint8Array(4_001))
  expect(declared.status).toBe(413)
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await Bun.sleep(1)
      controller.enqueue(new Uint8Array(1_000))
      sent += 1_000
    },
  })
  const controller = new AbortController()
  const undeclared = await fetch(rig.url('/restore/upload'), { method: 'POST', headers: bearer(rig), body: stream, signal: controller.signal })
  expect(undeclared.status).toBe(413)
  expect(sent).toBeLessThan(200_000)
  controller.abort()
  expect(readdirSync(join(dataDir, RESTORE_INCOMING_DIR))).toEqual([])
  const fits = await upload(rig, new Uint8Array(3_000))
  expect(fits.status).toBe(400)
})

test('a wrong recovery code is refused before anything changes, and is never echoed or logged', async () => {
  const { rig, dataDir, keyStore, key } = box({ titles: ['mine'] })
  const { file } = await backupFile()
  const id = await uploaded(rig, file)
  const wrong = encodeRecoveryCode(newDbKey())
  const response = await rig.bearer('POST', '/restore', { upload: id, code: wrong })
  expect(response.status).toBe(400)
  const text = await response.text()
  expect(text).toContain('does not open this backup')
  expect(text).not.toContain(wrong)
  const mistyped = await rig.bearer('POST', '/restore', { upload: id, code: `${wrong.slice(0, -1)}${wrong.endsWith('0') ? '1' : '0'}` })
  expect(mistyped.status).toBe(400)
  expect(await mistyped.text()).not.toContain(wrong.slice(0, 20))
  expect((await statusOf(rig)).state).toBe('idle')
  expect(await titlesOver(rig)).toContain('mine')
  expect(keyStore.values.get(DB_KEY_REF)).toBe(key!)
  expect(existsSync(maintenancePath(join(dataDir, DB_FILE)))).toBe(false)
  expect(rig.logs.join('\n')).not.toContain(wrong)
  // The upload is still there, so the right code can follow.
  expect(readdirSync(join(dataDir, RESTORE_INCOMING_DIR))).toHaveLength(1)
})

test('the restore body takes exactly an upload and a code', async () => {
  const { rig } = box()
  for (const body of [{}, { upload: 5 }, { upload: 'a'.repeat(32), code: 7 }, { upload: 'a'.repeat(32), extra: true }, []]) {
    expect((await rig.bearer('POST', '/restore', body)).status).toBe(400)
  }
  const unknown = await rig.bearer('POST', '/restore', { upload: 'a'.repeat(32) })
  expect(unknown.status).toBe(400)
  expect(((await unknown.json()) as { error: string }).error).toContain('choose the backup file again')
  expect((await rig.bearer('POST', '/restore/status')).status).toBe(405)
})

test('a restore inside the daemon: the session survives, the store is replaced, and the code appears nowhere', async () => {
  const { rig, dataDir, keyStore, key } = box({ titles: ['mine'] })
  const source = await backupFile({ titles: ['from the backup'] })
  const code = encodeRecoveryCode(source.key!)
  const cookie = await rig.login()
  const page = { cookie, origin: rig.origin, 'x-sam-request': '1' }
  const sent = await upload(rig, readFileSync(source.file), page)
  expect(sent.status).toBe(200)
  const { upload: id } = (await sent.json()) as { upload: string }
  const started = await rig.page('POST', '/restore', { cookie, body: { upload: id, code } })
  expect(started.status).toBe(202)
  expect(await started.text()).not.toContain(code)
  const status = await settled(rig)
  expect(status).toMatchObject({ state: 'done', error: null })
  expect(status.lines.join('\n')).toContain('restored the backup')
  expect(status.lines.join('\n')).toContain(replacedPath(join(dataDir, DB_FILE)))

  // The same cookie still works, and reads the restored memory.
  const after = await titlesOver(rig, { cookie })
  expect(after).toContain('from the backup')
  expect(after).not.toContain('mine')
  expect(keyStore.values.get(DB_KEY_REF)).toBe(source.key!)
  expect(keyStore.values.get(DB_KEY_REPLACED_REF)).toBe(key!)
  expect(existsSync(maintenancePath(join(dataDir, DB_FILE)))).toBe(false)
  expect(readdirSync(join(dataDir, RESTORE_INCOMING_DIR))).toEqual([])
  // The daemon writes to the restored store again.
  expect((await rig.bearer('POST', '/spool/nudge')).status).toBe(202)
  const health = (await (await fetch(rig.url('/health'))).json()) as { schemaVersion: number }
  expect(health.schemaVersion).toBe(LATEST_SCHEMA_VERSION)

  const everything = [...rig.logs, JSON.stringify(status)].join('\n')
  for (const secret of [code, code.replace(/-/g, ''), source.key!, key!]) expect(everything).not.toContain(secret)
})

test('while the restore waits for the store, store routes answer 503 and the rest keeps working; a second run is refused', async () => {
  let release: () => void = () => {}
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  let sleeps = 0
  const { rig, dataDir } = box({ encrypted: false, titles: ['mine'], backup: { sleep: () => (sleeps += 1, waiting), lockAttempts: 2 } })
  const source = await backupFile({ encrypted: false })
  const cookie = await rig.login()
  const id = await uploaded(rig, source.file)
  // Another process (an agent's MCP server) still has the store open.
  const holder = openPlain(join(dataDir, DB_FILE))
  holder.query('SELECT count(*) FROM observations').get()
  try {
    expect((await rig.bearer('POST', '/restore', { upload: id })).status).toBe(202)
    for (let tries = 0; sleeps === 0 && tries < 400; tries += 1) await Bun.sleep(5)
    expect(sleeps).toBe(1)
    expect(await statusOf(rig)).toMatchObject({ state: 'running', step: 'close' })
    const store = await rig.bearer('GET', '/memory/observations')
    expect(store.status).toBe(503)
    expect(((await store.json()) as { error: string }).error).toContain('restoring')
    expect((await rig.bearer('POST', '/spool/nudge')).status).toBe(503)
    expect((await fetch(rig.url('/health'))).status).toBe(200)
    expect((await rig.page('GET', '/dashboard/', { cookie, bare: true })).status).toBe(200)
    expect((await rig.bearer('GET', '/backup')).status).toBe(409)
    expect((await upload(rig, readFileSync(source.file))).status).toBe(409)
    expect((await rig.bearer('POST', '/restore', { upload: id })).status).toBe(409)
  } finally {
    release()
  }
  // The holder never let go: the restore gives up, and the daemon serves the old store again.
  const status = await settled(rig)
  holder.close()
  expect(status.state).toBe('failed')
  expect(status.error).toContain('another process is using memory.db')
  expect(await titlesOver(rig)).toContain('mine')
  expect(existsSync(maintenancePath(join(dataDir, DB_FILE)))).toBe(false)
  // Nothing is stuck: the same upload restores once the store is free.
  expect((await rig.bearer('POST', '/restore', { upload: id })).status).toBe(202)
  expect((await settled(rig)).state).toBe('done')
  expect(await titlesOver(rig)).toContain('from the backup')
})

test('an unencrypted backup restores without a code and the result warns', async () => {
  const { rig } = box({ encrypted: false })
  const source = await backupFile({ encrypted: false })
  const id = await uploaded(rig, source.file)
  expect((await rig.bearer('POST', '/restore', { upload: id })).status).toBe(202)
  const status = await settled(rig)
  expect(status.state).toBe('done')
  expect(status.lines.join('\n')).toContain('not encrypted')
  expect(await titlesOver(rig)).toContain('from the backup')
})

test('a restore that can be neither undone nor finished leaves the marker and stops the daemon', async () => {
  const keyStore = recordingKeyStore()
  const source = await backupFile()
  const set = keyStore.set.bind(keyStore)
  // The key store takes db-key-next but fails once the restored store is in place and db-key must follow.
  keyStore.set = (account, value) => {
    if (account === DB_KEY_REF && value === source.key) throw new Error('the key store is locked')
    set(account, value)
  }
  const fatal: string[] = []
  const { rig, dataDir } = box({ keyStore, backup: { onFatal: (reason) => fatal.push(reason) } })
  const id = await uploaded(rig, source.file)
  expect((await rig.bearer('POST', '/restore', { upload: id, code: encodeRecoveryCode(source.key!) })).status).toBe(202)
  const status = await settled(rig)
  expect(status.state).toBe('failed')
  expect(status.error).toContain('kinfold key resume')
  expect(fatal).toHaveLength(1)
  expect(existsSync(maintenancePath(join(dataDir, DB_FILE)))).toBe(true)
  expect((await rig.bearer('GET', '/memory/observations')).status).toBe(503)
})
