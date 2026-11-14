import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readArchive } from '../backup/archive'
import { inspectBackup, applyRestore, replacedPath, stageSnapshot } from '../backup/restore'
import { PROJECT_A, seedMcpObservation, seedMcpSession } from '../mcp/test-support'
import { DB_KEY_NEXT_REF, DB_KEY_REF, DB_KEY_REPLACED_REF } from '../secrets/credentials'
import { dbKeyStoreOf, newDbKey } from '../sqlite/keys'
import { fileState, maintenancePath } from '../sqlite/open'
import { encodeRecoveryCode } from '../sqlite/recovery'
import { DB_FILE } from '../store/data-dir'
import { openStore } from '../store/db'
import { parseBackupArgs } from './args'
import { runBackupCommand } from './backup-cli'
import { runKeyCommand } from './encrypt'
import type { InstallEnv } from './env'
import { EXIT_FAILED, EXIT_OK } from './install'
import { type FakeWorld, type RecordingKeyStore, createWorld, recordingKeyStore, startWorldDaemon } from './test-support'

const worlds: FakeWorld[] = []
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.cleanup()
})

interface Machine {
  w: FakeWorld
  env: InstallEnv
  keyStore: RecordingKeyStore
  key: string | null
  asked: string[]
}

/** A machine with its own key store and a store holding `titles`; the daemon is down. */
function machine(options: { encrypted?: boolean; titles?: string[]; code?: string; interactive?: boolean; stdin?: string } = {}): Machine {
  const w = createWorld()
  worlds.push(w)
  const keyStore = recordingKeyStore()
  const key = options.encrypted === false ? null : newDbKey()
  if (key !== null) keyStore.set(DB_KEY_REF, key)
  const store = openStore(w.dataDir, { keys: dbKeyStoreOf(key === null ? null : keyStore) })
  for (const title of options.titles ?? []) {
    const session = seedMcpSession(store, PROJECT_A, 'claude-code', `session-${title}`)
    seedMcpObservation(store, { projectKey: PROJECT_A, sessionId: session, title, at: 1_790_000_000_000 })
  }
  store.db.close()
  const asked: string[] = []
  const env: InstallEnv = {
    ...w.env,
    keyStore,
    io: {
      interactive: options.interactive ?? true,
      ask: async (question) => (asked.push(question), ''),
      askSecret: async (question) => (asked.push(question), options.code ?? ''),
      readStdin: async () => options.stdin ?? '',
    },
  }
  return { w, env, keyStore, key, asked }
}

function titles(m: Machine): string[] {
  const store = openStore(m.w.dataDir, { keys: dbKeyStoreOf(m.keyStore) })
  try {
    return store.db.query<{ title: string }, []>('SELECT title FROM observations ORDER BY id').all().map((row) => row.title)
  } finally {
    store.db.close()
  }
}

async function backupOf(m: Machine, name = 'memory.kfb'): Promise<string> {
  const file = join(m.w.root, name)
  expect(await runBackupCommand(m.env, { command: 'backup', file })).toBe(EXIT_OK)
  return file
}

test('backup then restore on another machine brings the memory and its key across', async () => {
  const old = machine({ titles: ['first', 'second'] })
  const file = await backupOf(old)
  expect(readArchive(file).manifest.encrypted).toBe(true)
  const code = encodeRecoveryCode(old.key!)
  const fresh = machine({ code })
  expect(await runBackupCommand(fresh.env, { command: 'restore', file })).toBe(EXIT_OK)
  expect(titles(fresh)).toEqual(['first', 'second'])
  expect(fresh.keyStore.values.get(DB_KEY_REF)).toBe(old.key!)
  expect(fresh.keyStore.values.has(DB_KEY_NEXT_REF)).toBe(false)
  expect(fresh.asked).toEqual(['Recovery code: '])
  for (const out of [old.w.out, fresh.w.out]) {
    const text = out.join('\n')
    expect(text).not.toContain(code)
    expect(text).not.toContain(old.key!)
    expect(text).not.toContain(fresh.key!)
  }
  expect(fresh.w.out.join('\n')).toContain('restored the backup')
})

test('backup says what it wrote and how to restore it', async () => {
  const m = machine({ titles: ['one'] })
  const file = await backupOf(m)
  const text = m.w.out.join('\n')
  expect(text).toContain(file)
  expect(text).toContain('recovery code')
  expect(text).toContain('kinfold key show-recovery')
})

test('a relative file is taken from the directory the command ran in', async () => {
  const m = machine({ titles: ['one'] })
  expect(await runBackupCommand(m.env, { command: 'backup', file: 'here.kfb' })).toBe(EXIT_OK)
  expect(existsSync(join(m.w.cwd, 'here.kfb'))).toBe(true)
})

test('backup refuses to replace a file, and says so when there is no store', async () => {
  const m = machine({ titles: ['one'] })
  const file = join(m.w.root, 'taken.kfb')
  writeFileSync(file, 'mine')
  expect(await runBackupCommand(m.env, { command: 'backup', file })).toBe(EXIT_FAILED)
  expect(readFileSync(file, 'utf8')).toBe('mine')
  const empty = createWorld()
  worlds.push(empty)
  expect(await runBackupCommand({ ...empty.env, keyStore: recordingKeyStore() }, { command: 'backup', file: join(empty.root, 'none.kfb') })).toBe(EXIT_FAILED)
  expect(empty.out.join('\n')).toContain('no memory')
  expect(existsSync(join(empty.root, 'none.kfb'))).toBe(false)
})

test('a wrong recovery code exits 1 and leaves the store and its key as they were', async () => {
  const old = machine({ titles: ['first'] })
  const file = await backupOf(old)
  const wrong = encodeRecoveryCode(newDbKey())
  const fresh = machine({ titles: ['mine'], code: wrong })
  expect(await runBackupCommand(fresh.env, { command: 'restore', file })).toBe(EXIT_FAILED)
  expect(titles(fresh)).toEqual(['mine'])
  expect(fresh.keyStore.values.get(DB_KEY_REF)).toBe(fresh.key!)
  expect(fresh.w.out.join('\n')).toContain('does not open this backup')
  expect(fresh.w.out.join('\n')).not.toContain(wrong)
})

test('a mistyped code is caught by its checksum before the backup is opened, without echoing it', async () => {
  const old = machine({ titles: ['first'] })
  const file = await backupOf(old)
  const typo = `${encodeRecoveryCode(old.key!).slice(0, -1)}${encodeRecoveryCode(old.key!).endsWith('0') ? '1' : '0'}`
  const fresh = machine({ code: typo })
  expect(await runBackupCommand(fresh.env, { command: 'restore', file })).toBe(EXIT_FAILED)
  expect(fresh.w.out.join('\n')).not.toContain(typo)
  expect(fresh.keyStore.values.get(DB_KEY_REF)).toBe(fresh.key!)
})

test('without a terminal the code comes from stdin', async () => {
  const old = machine({ titles: ['first'] })
  const file = await backupOf(old)
  const fresh = machine({ interactive: false, stdin: `${encodeRecoveryCode(old.key!)}\n` })
  expect(await runBackupCommand(fresh.env, { command: 'restore', file })).toBe(EXIT_OK)
  expect(titles(fresh)).toEqual(['first'])
  expect(fresh.asked).toEqual([])
})

test('an unencrypted backup restores with no code and warns', async () => {
  const old = machine({ encrypted: false, titles: ['plain'] })
  const file = await backupOf(old)
  expect(old.w.out.join('\n')).toContain('not encrypted')
  const fresh = machine()
  expect(await runBackupCommand(fresh.env, { command: 'restore', file })).toBe(EXIT_OK)
  expect(fresh.asked).toEqual([])
  expect(fileState(join(fresh.w.dataDir, DB_FILE))).toBe('plain')
  expect(titles(fresh)).toEqual(['plain'])
  expect(fresh.w.out.join('\n')).toContain('not encrypted')
})

test('a store with memory is kept, and restore says where and how to switch back', async () => {
  const old = machine({ titles: ['first'] })
  const file = await backupOf(old)
  const used = machine({ titles: ['mine'], code: encodeRecoveryCode(old.key!) })
  expect(await runBackupCommand(used.env, { command: 'restore', file })).toBe(EXIT_OK)
  expect(titles(used)).toEqual(['first'])
  const text = used.w.out.join('\n')
  expect(text).toContain(replacedPath(join(used.w.dataDir, DB_FILE)))
  expect(text).toContain('switch back')
  expect(used.keyStore.values.get(DB_KEY_REPLACED_REF)).toBe(used.key!)
})

test('a file that is not a backup, or one from a newer Kinfold, is refused before a code is asked for', async () => {
  const fresh = machine({ code: 'never asked' })
  const junk = join(fresh.w.root, 'junk.kfb')
  writeFileSync(junk, 'not a backup at all, just some bytes')
  expect(await runBackupCommand(fresh.env, { command: 'restore', file: junk })).toBe(EXIT_FAILED)
  expect(await runBackupCommand(fresh.env, { command: 'restore', file: join(fresh.w.root, 'missing.kfb') })).toBe(EXIT_FAILED)
  expect(fresh.asked).toEqual([])
  expect(fresh.w.out.join('\n')).toContain('not a Kinfold backup')
})

async function cutShort(m: Machine, file: string, key: string, point: 'after-keys' | 'after-move-in'): Promise<void> {
  const header = inspectBackup(file)
  const staged = await stageSnapshot({ dataDir: m.w.dataDir, archivePath: file, header, key })
  await expect(applyRestore({ dataDir: m.w.dataDir, staged, keyStore: m.keyStore, log: () => {}, sleep: async () => {}, faultAt: point })).rejects.toThrow()
}

test('kinfold key resume finishes a restore that was killed after the backup was in place', async () => {
  const old = machine({ titles: ['first'] })
  const file = await backupOf(old)
  const fresh = machine({ titles: ['mine'] })
  await cutShort(fresh, file, old.key!, 'after-move-in')
  expect(await runKeyCommand(fresh.env, 'resume')).toBe(EXIT_OK)
  expect(titles(fresh)).toEqual(['first'])
  expect(existsSync(maintenancePath(join(fresh.w.dataDir, DB_FILE)))).toBe(false)
  expect(fresh.w.out.join('\n')).toContain('finished')
})

test('kinfold key resume undoes a restore that was killed before the swap', async () => {
  const old = machine({ titles: ['first'] })
  const file = await backupOf(old)
  const fresh = machine({ titles: ['mine'] })
  await cutShort(fresh, file, old.key!, 'after-keys')
  expect(await runKeyCommand(fresh.env, 'resume')).toBe(EXIT_OK)
  expect(titles(fresh)).toEqual(['mine'])
  expect(fresh.keyStore.values.get(DB_KEY_REF)).toBe(fresh.key!)
  expect(fresh.keyStore.values.has(DB_KEY_NEXT_REF)).toBe(false)
  expect(fresh.w.out.join('\n')).toContain('back as it was')
})

test('while a restore is cut short, backup, restore and the key commands refuse and point at resume', async () => {
  const old = machine({ titles: ['first'] })
  const file = await backupOf(old)
  const fresh = machine({ titles: ['mine'], code: encodeRecoveryCode(old.key!) })
  await cutShort(fresh, file, old.key!, 'after-keys')
  expect(await runKeyCommand(fresh.env, 'rekey')).toBe(EXIT_FAILED)
  expect(await runKeyCommand(fresh.env, 'decrypt')).toBe(EXIT_FAILED)
  expect(await runBackupCommand(fresh.env, { command: 'restore', file })).toBe(EXIT_FAILED)
  expect(await runBackupCommand(fresh.env, { command: 'backup', file: join(fresh.w.root, 'during.kfb') })).toBe(EXIT_FAILED)
  const text = fresh.w.out.join('\n')
  expect(text).toContain('restore')
  expect(text).toContain('kinfold key resume')
  expect(existsSync(join(fresh.w.root, 'during.kfb'))).toBe(false)
})

test('a restore whose process is still alive is left alone by resume', async () => {
  const fresh = machine({ titles: ['mine'] })
  const marker = maintenancePath(join(fresh.w.dataDir, DB_FILE))
  writeFileSync(marker, JSON.stringify({ op: 'restore', pid: process.ppid, startedAt: 1, previous: 'encrypted', encrypted: true, keepPrevious: true, settings: {} }))
  expect(await runKeyCommand(fresh.env, 'resume')).toBe(EXIT_FAILED)
  expect(fresh.w.out.join('\n')).toContain('still running')
  expect(existsSync(marker)).toBe(true)
})

test('backup and restore each take exactly one file', () => {
  expect(parseBackupArgs(['status'])).toBeNull()
  expect(parseBackupArgs(['backup', '/tmp/a.kfb'])).toEqual({ ok: true, value: { command: 'backup', file: '/tmp/a.kfb' } })
  expect(parseBackupArgs(['restore', 'a.kfb'])).toEqual({ ok: true, value: { command: 'restore', file: 'a.kfb' } })
  for (const argv of [['backup'], ['restore'], ['backup', 'a', 'b'], ['restore', '--force'], ['backup', '']]) {
    expect(parseBackupArgs(argv)).toMatchObject({ ok: false })
  }
})

/** Starts the machine's daemon on its own key store, and records every URL the command asks for. */
function withDaemon(m: Machine): { urls: string[]; bodies: string[] } {
  m.w.env.keyStore = m.keyStore
  m.w.launchd.daemon = startWorldDaemon(m.w, m.w.dataDir)
  const urls: string[] = []
  const bodies: string[] = []
  const inner = m.env.fetch
  m.env.fetch = (url, init) => {
    urls.push(url)
    if (typeof init.body === 'string') bodies.push(init.body)
    return inner(url, init)
  }
  return { urls, bodies }
}

test('with the daemon running, backup comes from GET /backup and restore goes through its routes', async () => {
  const old = machine({ titles: ['first', 'second'] })
  const oldCalls = withDaemon(old)
  const file = await backupOf(old)
  expect(oldCalls.urls.some((url) => url.endsWith('/backup'))).toBe(true)
  expect(readArchive(file).manifest.encrypted).toBe(true)
  expect(existsSync(`${file}.partial`)).toBe(false)
  expect(old.w.out.join('\n')).toContain(file)

  const code = encodeRecoveryCode(old.key!)
  const fresh = machine({ titles: ['mine'], code })
  const calls = withDaemon(fresh)
  expect(await runBackupCommand(fresh.env, { command: 'restore', file })).toBe(EXIT_OK)
  const paths = calls.urls.map((url) => new URL(url).pathname)
  expect(paths).toContain('/restore/upload')
  expect(paths).toContain('/restore')
  expect(paths).toContain('/restore/status')
  expect(titles(fresh)).toEqual(['first', 'second'])
  expect(fresh.keyStore.values.get(DB_KEY_REF)).toBe(old.key!)
  expect(fresh.keyStore.values.get(DB_KEY_REPLACED_REF)).toBe(fresh.key!)
  const text = fresh.w.out.join('\n')
  expect(text).toContain('restored the backup')
  expect(text).toContain('switch back')
  expect(text).not.toContain('the daemon is not running')
  // The code went in one request body and nowhere else: no URL, no output.
  expect(calls.bodies.filter((body) => body.includes(code))).toHaveLength(1)
  for (const url of calls.urls) {
    expect(url).not.toContain(code)
    expect(url).not.toContain(code.replace(/-/g, ''))
    expect(new URL(url).search).toBe('')
  }
  expect(text).not.toContain(code)
  // The daemon still serves, on the restored store.
  expect((await fresh.env.fetch(calls.urls[0]!.replace(/\/[^/]*$/, '/health'), {})).status).toBe(200)
})

test('with the daemon running, a wrong code fails the command and the store stays', async () => {
  const old = machine({ titles: ['first'] })
  const file = await backupOf(old)
  const wrong = encodeRecoveryCode(newDbKey())
  const fresh = machine({ titles: ['mine'], code: wrong })
  withDaemon(fresh)
  expect(await runBackupCommand(fresh.env, { command: 'restore', file })).toBe(EXIT_FAILED)
  expect(fresh.w.out.join('\n')).toContain('does not open this backup')
  expect(fresh.w.out.join('\n')).not.toContain(wrong)
  expect(titles(fresh)).toEqual(['mine'])
  expect(fresh.keyStore.values.get(DB_KEY_REF)).toBe(fresh.key!)
})

test('with the daemon running, backup still refuses to replace a file', async () => {
  const m = machine({ titles: ['one'] })
  withDaemon(m)
  const file = join(m.w.root, 'taken.kfb')
  writeFileSync(file, 'mine')
  expect(await runBackupCommand(m.env, { command: 'backup', file })).toBe(EXIT_FAILED)
  expect(readFileSync(file, 'utf8')).toBe('mine')
})
