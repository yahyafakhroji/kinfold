import { afterEach, expect, test } from 'bun:test'
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedObservation } from '../context/test-support'
import { T0, seedSession } from '../observer/test-support'
import { DB_KEY_NEXT_REF, DB_KEY_REF } from '../secrets/credentials'
import { backupPath } from '../sqlite/convert'
import { type DbKeyStore, NO_DB_KEYS, newDbKey } from '../sqlite/keys'
import { fileState, maintenancePath, openEncrypted, openPlain } from '../sqlite/open'
import { decodeRecoveryCode, encodeRecoveryCode } from '../sqlite/recovery'
import { openStore } from '../store/db'
import { DB_FILE } from '../store/data-dir'
import { upsertProject } from '../store/writes'
import { type Journal, runKeyCommand } from './encrypt'
import type { InstallEnv } from './env'
import { EXIT_FAILED, EXIT_OK } from './install'
import { type FakeWorld, createWorld, fakeService, startWorldDaemon } from './test-support'
import { LAUNCHCTL } from './launch-agent'
import { LSOF } from './service/launch-agent-service'

const worlds: FakeWorld[] = []
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.cleanup()
})

const CODE = /([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}/

/** A world holding a seeded store, plaintext or encrypted with `key`, whose prompts answer from what was printed. */
function world(key: string | null, answer: (out: string[]) => string = (out) => printedCode(out).split('-').slice(-2).join('-')): { w: FakeWorld; env: InstallEnv; path: string } {
  const w = createWorld({ keychainRefs: key === null ? [] : [DB_KEY_REF] })
  worlds.push(w)
  if (key !== null) w.keychainValues.set(DB_KEY_REF, key)
  const keys: DbKeyStore = key === null ? NO_DB_KEYS : { name: 'test', read: () => key, exists: () => true }
  const store = openStore(w.dataDir, { keys })
  upsertProject(store.db, { key: 'p', kind: 'path', displayName: 'p' }, T0)
  const session = seedSession(store, 'claude-code', 's')
  for (let i = 0; i < 10; i++) seedObservation(store, { sessionId: session, projectKey: 'p', host: 'claude-code', title: `note ${i}`, at: T0 + i })
  store.db.close()
  const env: InstallEnv = { ...w.env, io: { ...w.env.io, interactive: true, ask: async () => answer(w.out), askSecret: async () => answer(w.out) } }
  return { w, env, path: join(w.dataDir, DB_FILE) }
}

function printedCode(out: readonly string[]): string {
  const line = [...out].reverse().find((entry) => CODE.test(entry))
  if (line === undefined) throw new Error('no recovery code printed')
  return CODE.exec(line)![0]
}

const rows = (db: ReturnType<typeof openPlain>): number => {
  try {
    return db.query<{ n: number }, []>('SELECT count(*) AS n FROM observations').get()!.n
  } finally {
    db.close()
  }
}

test('kinfold encrypt shows a code, waits for its last group, then encrypts with the key it put in the Keychain', async () => {
  const { w, env, path } = world(null)
  expect(await runKeyCommand(env, 'encrypt')).toBe(EXIT_OK)
  const key = w.keychainValues.get(DB_KEY_REF)!
  expect(key).toMatch(/^[0-9a-f]{64}$/)
  expect(decodeRecoveryCode(printedCode(w.out))).toBe(key)
  expect(fileState(path)).toBe('encrypted')
  expect(rows(openEncrypted(path, key))).toBe(10)
  expect(existsSync(maintenancePath(path))).toBe(false)
  expect(existsSync(backupPath(path))).toBe(false)
  expect(w.out.join('\n')).not.toContain(key)
  expect(w.securityCalls.some((call) => call.args.join(' ').includes(key))).toBe(false)
  expect(w.out).toContain('memory.db is encrypted.')
})

test('the wrong last group, or no terminal, changes nothing', async () => {
  const typo = world(null, () => 'ZZZZZ')
  expect(await runKeyCommand(typo.env, 'encrypt')).toBe(EXIT_FAILED)
  expect(fileState(typo.path)).toBe('plain')
  expect(typo.w.keychain.has(DB_KEY_REF)).toBe(false)
  expect(typo.w.out.at(-1)).toBe('kinfold encrypt: those were not the last two groups; nothing changed')
  const pipe = world(null)
  expect(await runKeyCommand({ ...pipe.env, io: { ...pipe.env.io, interactive: false } }, 'encrypt')).toBe(EXIT_FAILED)
  expect(pipe.w.out.at(-1)).toContain('needs a terminal')
  expect(fileState(pipe.path)).toBe('plain')
})

test('another process holding the store makes encrypt refuse, the store stays plaintext, and the key it wrote goes', async () => {
  const { w, env, path } = world(null)
  const other = openPlain(path, { readonly: true })
  other.query('SELECT 1').get()
  try {
    expect(await runKeyCommand(env, 'encrypt')).toBe(EXIT_FAILED)
  } finally {
    other.close()
  }
  expect(w.out.at(-1)).toContain('another process is using memory.db')
  expect(fileState(path)).toBe('plain')
  expect(w.keychain.has(DB_KEY_REF)).toBe(false)
  expect(existsSync(maintenancePath(path))).toBe(false)
})

test('kinfold rekey moves the store to a new key and a new code; the old key stops working and db-key-next goes', async () => {
  const old = newDbKey()
  const { w, env, path } = world(old)
  expect(await runKeyCommand(env, 'rekey')).toBe(EXIT_OK)
  const key = w.keychainValues.get(DB_KEY_REF)!
  expect(key).not.toBe(old)
  expect(decodeRecoveryCode(printedCode(w.out))).toBe(key)
  expect(w.keychain.has(DB_KEY_NEXT_REF)).toBe(false)
  expect(() => openEncrypted(path, old)).toThrow(expect.objectContaining({ kind: 'bad_key' }))
  expect(rows(openEncrypted(path, key))).toBe(10)
})

test('if moving the new key into db-key fails after a good rekey, nothing is deleted and the way back is named', async () => {
  const old = newDbKey()
  const { w, env, path } = world(old)
  let writes = 0
  const failing: InstallEnv = {
    ...env,
    // The first write (db-key-next) works; the second (db-key, after the conversion) fails.
    security: (invocation) => (invocation.args[0] === '-i' && ++writes === 2 ? { exitCode: 1, stdout: '' } : env.security(invocation)),
  }
  expect(await runKeyCommand(failing, 'rekey')).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toContain(`memory.db was converted, but the new key is still under ${DB_KEY_NEXT_REF}`)
  const next = w.keychainValues.get(DB_KEY_NEXT_REF)!
  expect(w.keychain.has(DB_KEY_NEXT_REF)).toBe(true)
  expect(rows(openEncrypted(path, next))).toBe(10)
})

test('kinfold decrypt asks for the word, stores plaintext again and deletes the key', async () => {
  const key = newDbKey()
  const { w, env, path } = world(key, () => 'decrypt')
  expect(await runKeyCommand(env, 'decrypt')).toBe(EXIT_OK)
  expect(fileState(path)).toBe('plain')
  expect(rows(openPlain(path))).toBe(10)
  expect(w.keychain.has(DB_KEY_REF)).toBe(false)
  const refused = world(newDbKey(), () => 'yes')
  expect(await runKeyCommand(refused.env, 'decrypt')).toBe(EXIT_FAILED)
  expect(fileState(refused.path)).toBe('encrypted')
})

test('show-recovery prints the code for the stored key, only to a terminal', async () => {
  const key = newDbKey()
  const { w, env } = world(key)
  expect(await runKeyCommand(env, 'show-recovery')).toBe(EXIT_OK)
  expect(w.out.at(-1)).toBe(`recovery code: ${encodeRecoveryCode(key)}`)
  expect(await runKeyCommand({ ...env, io: { ...env.io, interactive: false } }, 'show-recovery')).toBe(EXIT_FAILED)
})

test('key recover puts the key back from a code on stdin, only when the code opens the store', async () => {
  const key = newDbKey()
  const { w, env } = world(key)
  w.keychain.delete(DB_KEY_REF)
  w.keychainValues.delete(DB_KEY_REF)
  const piped = (code: string): InstallEnv => ({ ...env, io: { ...env.io, interactive: false, readStdin: async () => `${code}\n` } })
  expect(await runKeyCommand(piped(encodeRecoveryCode(newDbKey())), 'recover')).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toBe('kinfold recover: that recovery code does not open memory.db; nothing changed')
  expect(await runKeyCommand(piped('not a code'), 'recover')).toBe(EXIT_FAILED)
  expect(w.keychain.has(DB_KEY_REF)).toBe(false)
  expect(await runKeyCommand(piped(encodeRecoveryCode(key).toLowerCase()), 'recover')).toBe(EXIT_OK)
  expect(w.keychainValues.get(DB_KEY_REF)).toBe(key)
})

test('each command refuses the wrong state', async () => {
  const plain = world(null)
  expect(await runKeyCommand(plain.env, 'rekey')).toBe(EXIT_FAILED)
  expect(plain.w.out.at(-1)).toBe('kinfold rekey: memory.db is not encrypted; kinfold encrypt converts it')
  const encrypted = world(newDbKey())
  expect(await runKeyCommand(encrypted.env, 'encrypt')).toBe(EXIT_FAILED)
  expect(encrypted.w.out.at(-1)).toBe('kinfold encrypt: memory.db is already encrypted')
  expect(await runKeyCommand({ ...encrypted.env, platform: 'linux' }, 'encrypt')).toBe(EXIT_FAILED)
})

test('encrypt waits for an agent session to let go of the store, then converts', async () => {
  const { w, env, path } = world(null)
  const other = openPlain(path, { readonly: true })
  other.query('SELECT 1').get()
  let sleeps = 0
  const waiting: InstallEnv = { ...env, sleep: async () => { if (++sleeps === 3) other.close() } }
  expect(await runKeyCommand(waiting, 'encrypt')).toBe(EXIT_OK)
  expect(sleeps).toBe(3)
  expect(w.out.some((line) => line.startsWith('waiting up to 36 s for agent sessions to let go of memory.db'))).toBe(true)
  expect(fileState(path)).toBe('encrypted')
})

// ---- Runs that were cut short, and kinfold key resume --------------------------

/** A pid no process has, so the journal reads as a run that died. */
const DEAD_PID = 2 ** 22 - 7

function journal(path: string, entry: Omit<Journal, 'pid' | 'startedAt'>): void {
  writeFileSync(maintenancePath(path), JSON.stringify({ ...entry, pid: DEAD_PID, startedAt: 0 }))
}

/** The rekey a killed run would have done, by hand: out of WAL, rekey, back to WAL. */
function rekeyByHand(path: string, from: string | null, to: string | null): void {
  const db = from === null ? openPlain(path) : openEncrypted(path, from)
  db.exec('PRAGMA journal_mode = DELETE')
  db.exec(to === null ? "PRAGMA rekey = ''" : `PRAGMA rekey = 'raw:${to}'`)
  db.exec('PRAGMA journal_mode = WAL')
  db.close()
}

test('encrypt killed after the rekey, before its backup went: resume sees the store open with the key and every count match, and finishes', async () => {
  const { w, env, path } = world(null)
  const key = newDbKey()
  w.keychain.add(DB_KEY_REF)
  w.keychainValues.set(DB_KEY_REF, key)
  journal(path, { op: 'encrypt', source: null, target: DB_KEY_REF })
  copyFileSync(path, backupPath(path))
  rekeyByHand(path, null, key)
  expect(await runKeyCommand(env, 'resume')).toBe(EXIT_OK)
  expect(w.out).toContain('the encrypt had finished; its backup is removed')
  expect(existsSync(backupPath(path))).toBe(false)
  expect(existsSync(maintenancePath(path))).toBe(false)
  expect(rows(openEncrypted(path, key))).toBe(10)
})

test('encrypt killed mid-rekey, the file torn: resume puts the backup back and takes the key away', async () => {
  const { w, env, path } = world(null)
  w.keychain.add(DB_KEY_REF)
  w.keychainValues.set(DB_KEY_REF, newDbKey())
  journal(path, { op: 'encrypt', source: null, target: DB_KEY_REF })
  copyFileSync(path, backupPath(path))
  writeFileSync(path, Buffer.alloc(8192, 0x5a))
  expect(await runKeyCommand(env, 'resume')).toBe(EXIT_OK)
  expect(w.out).toContain('the encrypt had not finished; memory.db is back as it was')
  expect(fileState(path)).toBe('plain')
  expect(rows(openPlain(path))).toBe(10)
  expect(w.keychain.has(DB_KEY_REF)).toBe(false)
  expect(existsSync(maintenancePath(path))).toBe(false)
})

test('encrypt killed before it touched the file: resume undoes the key and clears the marker', async () => {
  const { w, env, path } = world(null)
  w.keychain.add(DB_KEY_REF)
  w.keychainValues.set(DB_KEY_REF, newDbKey())
  journal(path, { op: 'encrypt', source: null, target: DB_KEY_REF })
  expect(await runKeyCommand(env, 'resume')).toBe(EXIT_OK)
  expect(w.out).toContain('the encrypt had not changed memory.db; it is as it was')
  expect(w.keychain.has(DB_KEY_REF)).toBe(false)
  expect(rows(openPlain(path))).toBe(10)
})

test('rekey killed after the conversion, before the key moved: resume moves db-key-next into db-key', async () => {
  const old = newDbKey()
  const { w, env, path } = world(old)
  const key = newDbKey()
  w.keychain.add(DB_KEY_NEXT_REF)
  w.keychainValues.set(DB_KEY_NEXT_REF, key)
  journal(path, { op: 'rekey', source: DB_KEY_REF, target: DB_KEY_NEXT_REF })
  rekeyByHand(path, old, key)
  expect(await runKeyCommand(env, 'resume')).toBe(EXIT_OK)
  expect(w.keychainValues.get(DB_KEY_REF)).toBe(key)
  expect(w.keychain.has(DB_KEY_NEXT_REF)).toBe(false)
  expect(rows(openEncrypted(path, key))).toBe(10)
})

test('while a run is cut short, the other commands refuse and point at resume; a backup that does not open is never deleted', async () => {
  const { w, env, path } = world(null)
  journal(path, { op: 'encrypt', source: null, target: DB_KEY_REF })
  expect(await runKeyCommand(env, 'encrypt')).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toBe('kinfold encrypt: a kinfold encrypt was cut short; run kinfold key resume first')
  writeFileSync(backupPath(path), Buffer.alloc(4096, 0x11))
  expect(await runKeyCommand(env, 'resume')).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toContain('does not open with the old key; nothing was changed')
  expect(existsSync(backupPath(path))).toBe(true)
  expect(existsSync(maintenancePath(path))).toBe(true)
})

test('a run that is still alive is left alone', async () => {
  const { w, env, path } = world(null)
  writeFileSync(maintenancePath(path), JSON.stringify({ op: 'encrypt', source: null, target: DB_KEY_REF, pid: process.ppid, startedAt: 0 }))
  expect(await runKeyCommand(env, 'resume')).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toBe(`kinfold resume: a kinfold encrypt is still running (pid ${process.ppid}); wait for it`)
  expect(await runKeyCommand(env, 'resume')).toBe(EXIT_FAILED)
})

test('encrypt asks before replacing an existing db-key, and keeps it unless told replace', async () => {
  const { w, env, path } = world(null, () => 'no')
  w.keychain.add(DB_KEY_REF)
  w.keychainValues.set(DB_KEY_REF, 'a'.repeat(64))
  expect(await runKeyCommand(env, 'encrypt')).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toBe(`kinfold encrypt: nothing changed; ${DB_KEY_REF} is kept`)
  expect(w.keychainValues.get(DB_KEY_REF)).toBe('a'.repeat(64))
  expect(fileState(path)).toBe('plain')
})

test('show-recovery refuses when stdout is a pipe', async () => {
  const { env } = world(newDbKey())
  expect(await runKeyCommand({ ...env, io: { ...env.io, printsToTerminal: false } }, 'show-recovery')).toBe(EXIT_FAILED)
})

test('encrypt and rekey refuse when stdout is a pipe, before any code is shown or anything changes', async () => {
  const plain = world(null)
  const piped = { ...plain.env, io: { ...plain.env.io, printsToTerminal: false } }
  expect(await runKeyCommand(piped, 'encrypt')).toBe(EXIT_FAILED)
  expect(plain.w.out.at(-1)).toContain('needs a terminal on stdout, not a pipe or a file')
  expect(plain.w.out).toHaveLength(1)
  expect(fileState(plain.path)).toBe('plain')
  expect(plain.w.keychain.has(DB_KEY_REF)).toBe(false)

  const encrypted = world(newDbKey())
  const pipedKey = { ...encrypted.env, io: { ...encrypted.env.io, printsToTerminal: false } }
  expect(await runKeyCommand(pipedKey, 'rekey')).toBe(EXIT_FAILED)
  expect(encrypted.w.out.at(-1)).toContain('needs a terminal on stdout, not a pipe or a file')
  expect(fileState(encrypted.path)).toBe('encrypted')
})

test('encrypt stops and starts through the service', async () => {
  const { w, env } = world(null)
  const service = fakeService()
  expect(await runKeyCommand({ ...env, service }, 'encrypt')).toBe(EXIT_OK)
  expect(service.calls).toEqual(['isRunning', 'stop', 'start'])
  expect(w.commands.filter((c) => c.argv[0] === LAUNCHCTL || c.argv[0] === LSOF)).toEqual([])
})

test('encrypt with no service refuses only when a daemon still answers', async () => {
  const quiet = world(null)
  expect(await runKeyCommand({ ...quiet.env, service: null }, 'encrypt')).toBe(EXIT_OK)
  expect(quiet.w.commands.filter((c) => c.argv[0] === LAUNCHCTL || c.argv[0] === LSOF)).toEqual([])

  const answering = world(null)
  const daemon = startWorldDaemon(answering.w, answering.w.dataDir)
  try {
    expect(await runKeyCommand({ ...answering.env, service: null }, 'encrypt')).toBe(EXIT_FAILED)
    expect(answering.w.out.join('\n')).toContain('a daemon still answers /health')
    expect(fileState(answering.path)).toBe('plain')
  } finally {
    await daemon.stop()
  }
})

test('a service that was not running is not started after encrypt', async () => {
  const { env } = world(null)
  const service = fakeService({ running: false })
  expect(await runKeyCommand({ ...env, service }, 'encrypt')).toBe(EXIT_OK)
  expect(service.calls).toEqual(['isRunning'])
})

test('a service that fails to stop is started again and the store and marker are untouched', async () => {
  const { w, env, path } = world(null)
  const service = fakeService({ stopError: new Error('still loaded') })
  expect(await runKeyCommand({ ...env, service }, 'encrypt')).toBe(EXIT_FAILED)
  expect(service.calls.at(-1)).toBe('start')
  expect(w.out.join('\n')).toContain('did not stop (still loaded); it was started again; nothing was changed')
  expect(fileState(path)).toBe('plain')
  expect(existsSync(maintenancePath(path))).toBe(false)
  expect(w.keychainValues.has(DB_KEY_REF)).toBe(false)
})
