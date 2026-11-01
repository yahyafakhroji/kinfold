import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HMAC_LEGACY_REF, HMAC_MASTER_REF, epochAt, isHexKey, markerSubKey } from '../secrets/hmac-keys'
import { readSubKey, subKeyDir } from '../store/hmac-key'
import { EXIT_FAILED, EXIT_OK, install } from './install'
import { existingBackups } from './files'
import { LAUNCHCTL } from './launch-agent'
import { status } from './status'
import { uninstall } from './uninstall'
import { type FakeWorld, YES, createWorld, snapshotTree, worldSubKeyEpochs } from './test-support'

const LEGACY = '4e'.repeat(32)
let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

/** A user from before P1-J: data dir with a plain-text hmac.key, nothing in the Keychain for it. */
function oldUser(platform: NodeJS.Platform = 'darwin', key = LEGACY): FakeWorld {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)', platform })
  mkdirSync(world.dataDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(world.dataDir, 'hmac.key'), key, { mode: 0o600 })
  return world
}
const legacyPath = (w: FakeWorld): string => join(w.dataDir, 'hmac.key')
const keyBytesIn = (w: FakeWorld, text: string): string[] =>
  [LEGACY, ...w.keychainValues.values()].filter((value) => isHexKey(value) && text.includes(value))
const hmacPuts = (w: FakeWorld): string[] =>
  w.securityCalls.filter((call) => call.args[0] === '-i').map((call) => /-a (\S+)/.exec(call.stdin ?? '')?.[1] ?? '').filter((ref) => ref.startsWith('hmac-'))

test('dry run: the migration shows in the plan, values hidden, and nothing changes', async () => {
  const w = oldUser()
  const before = snapshotTree(w.home)
  expect(await install(w.env, { ...YES, dryRun: true })).toBe(EXIT_OK)
  expect(snapshotTree(w.home)).toEqual(before)
  const plan = w.out.join('\n')
  expect(plan).toContain(`keychain: /usr/bin/security -i <<< "add-generic-password -U -s kinfold -a ${HMAC_LEGACY_REF} -w <hidden>"`)
  expect(plan).toContain(`keychain: /usr/bin/security -i <<< "add-generic-password -U -s kinfold -a ${HMAC_MASTER_REF} -w <hidden>"`)
  expect(plan).toContain(`mkdir ${subKeyDir(w.dataDir)} (mode 0700)`)
  expect(plan).toMatch(/write .*hmac\.d\/2026\d\d\.key: marker sub-key for epoch 2026\d\d, derived from the new master/)
  expect(plan).toMatch(new RegExp(`back up ${legacyPath(w)} -> ${legacyPath(w)}\\.kinfold-backup-\\d{8}T\\d{6}Z \\(mode 0600\\)`))
  expect(plan).toContain(`remove ${legacyPath(w)}: the plain-text marker key; its value is now keychain entry hmac-legacy (epoch 0)`)
  expect(plan).not.toContain(LEGACY)
  expect(w.securityCalls.filter((call) => call.args[0] === '-i')).toEqual([])
})

test('apply: legacy key into the Keychain, a new random master, a sub-key on disk, hmac.key backed up, removed, then the backup removed', async () => {
  const w = oldUser()
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(hmacPuts(w)).toEqual([HMAC_LEGACY_REF, HMAC_MASTER_REF])
  expect(w.keychainValues.get(HMAC_LEGACY_REF)).toBe(LEGACY)
  const master = w.keychainValues.get(HMAC_MASTER_REF)!
  expect(isHexKey(master)).toBe(true)
  expect(master).not.toBe(LEGACY)
  expect(existsSync(legacyPath(w))).toBe(false)
  const backupStep = w.out.findIndex((line) => line.includes(`.kinfold-backup-`) && line.includes('back up'))
  expect(w.out[backupStep]).toMatch(/\(mode 0600\)  \[done\]$/)
  expect(existingBackups(legacyPath(w))).toEqual([])
  const removal = w.out.findIndex((line) => /remove .*hmac\.key\.kinfold-backup-\d{8}T\d{6}Z: plain-text backup of epoch 0; the value is in keychain entry hmac-legacy  \[done\]$/.test(line))
  expect(removal).toBeGreaterThan(w.out.findIndex((line) => line.includes('wait up to 15 s for GET /health')))
  const epoch = epochAt(Date.now())
  expect(readSubKey(w.dataDir, epoch)).toBe(markerSubKey(master, epoch))
  expect(w.launchd.daemon?.hmacKeys.mode()).toBe('master')
  expect(keyBytesIn(w, w.out.join('\n'))).toEqual([])
})

test('a second install has nothing to migrate and writes no Keychain entry', async () => {
  const w = oldUser()
  await install(w.env, YES)
  const puts = hmacPuts(w).length
  w.out.length = 0
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(hmacPuts(w)).toHaveLength(puts)
  expect(w.out).toContain('hmac keys: master in keychain, no hmac.key; nothing to migrate')
})

test('a loaded daemon with an unchanged plist is restarted when a master is created, so it reads it', async () => {
  const w = oldUser()
  await install(w.env, YES)
  w.keychain.delete(HMAC_MASTER_REF)
  w.keychainValues.delete(HMAC_MASTER_REF)
  writeFileSync(legacyPath(w), LEGACY, { mode: 0o600 })
  const calls = w.commands.length
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const verbs = w.commands.slice(calls).filter((c) => c.argv[0] === LAUNCHCTL).map((c) => c.argv[1])
  expect(verbs).toEqual(['print', 'bootout', 'bootstrap'])
  expect(w.launchd.daemon?.hmacKeys.mode()).toBe('master')
})

test('status reports the entries and the sub-key epochs, and no backup once install removed it; it reads no master', async () => {
  const w = oldUser()
  await install(w.env, YES)
  w.out.length = 0
  const reads = w.securityCalls.length
  await status(w.env)
  expect(w.out).toContain('hmac keys: keychain master; keychain hmac-master present, hmac-legacy present')
  expect(w.out).toContain(`  sub-keys in ${subKeyDir(w.dataDir)}: epochs ${worldSubKeyEpochs().join(', ')}`)
  expect(w.out.filter((line) => line.includes('warning'))).toEqual([])
  expect(w.securityCalls.slice(reads).filter((call) => call.args.includes('-w') && call.args.includes(HMAC_MASTER_REF))).toEqual([])
})

test('uninstall keeps the HMAC entries, even with --remove-credentials, and says how to remove them', async () => {
  const w = oldUser()
  await install(w.env, YES)
  w.out.length = 0
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: true })).toBe(EXIT_OK)
  expect(w.keychain.has(HMAC_MASTER_REF) && w.keychain.has(HMAC_LEGACY_REF)).toBe(true)
  expect(w.out).toContain('kept keychain entry hmac-master (marker refs in the data dir need it); remove it with: security delete-generic-password -s kinfold -a hmac-master  (or rerun with --remove-hmac-keys)')
  expect(w.out).toContain('kept keychain entry hmac-legacy (marker refs in the data dir need it); remove it with: security delete-generic-password -s kinfold -a hmac-legacy  (or rerun with --remove-hmac-keys)')
})

test('without a keychain (linux) nothing migrates and hmac.key stays', async () => {
  const w = oldUser('linux')
  expect(await install(w.env, { ...YES, dryRun: true })).toBe(EXIT_OK)
  expect(w.out).toContain(`hmac keys: no keychain on linux; the marker key stays in ${legacyPath(w)}`)
  expect(readFileSync(legacyPath(w), 'utf8')).toBe(LEGACY)
})

test('an hmac.key that is not a key stops the install before step 1, without quoting it', async () => {
  const w = oldUser('darwin', 'not a key at all')
  const before = snapshotTree(w.home)
  expect(await install(w.env, YES)).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toBe(`install failed: ${legacyPath(w)} does not hold a 32-byte hex key; leaving it untouched`)
  expect(snapshotTree(w.home)).toEqual(before)
})
