import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HMAC_LEGACY_REF, HMAC_MASTER_REF } from '../secrets/hmac-keys'
import type { SecurityRunner } from '../secrets/keychain-writer'
import { subKeyDir } from '../store/hmac-key'
import { USAGE, parseArgs } from './args'
import { existingBackups } from './files'
import { EXIT_FAILED, EXIT_OK, install } from './install'
import { status } from './status'
import { type FakeWorld, YES, createWorld, snapshotTree, worldSubKeyEpochs } from './test-support'
import { uninstall } from './uninstall'

const LEGACY = '4e'.repeat(32)
const OTHER = '7a'.repeat(32)
const OLD_BACKUP = 'hmac.key.sam-backup-20260901T000000Z'
let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

function oldUser(): FakeWorld {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)' })
  mkdirSync(world.dataDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(world.dataDir, 'hmac.key'), LEGACY, { mode: 0o600 })
  return world
}
const legacyPath = (w: FakeWorld): string => join(w.dataDir, 'hmac.key')
const backups = (w: FakeWorld): string[] => existingBackups(legacyPath(w))
const keyBytes = (w: FakeWorld): string[] => [LEGACY, OTHER, ...w.keychainValues.values()].filter((value) => w.out.join('\n').includes(value))
const isLegacyRead = (args: readonly string[]): boolean => args.includes('-w') && args.includes(HMAC_LEGACY_REF)

/** Wraps the fake `security`; the test daemon reads through world.env too, so it sees the same answers. */
function wrapSecurity(w: FakeWorld, wrap: (inner: SecurityRunner) => SecurityRunner): void {
  w.env = { ...w.env, security: wrap(w.env.security) }
}

async function statusOut(w: FakeWorld): Promise<string[]> {
  w.out.length = 0
  await status(w.env)
  return w.out.filter((line) => line.includes('hmac') || line.includes('sub-keys') || line.includes('backup'))
}

test('install removes the backup after a healthy master-mode reload, and an older matching one too', async () => {
  const w = oldUser()
  writeFileSync(join(w.dataDir, OLD_BACKUP), LEGACY, { mode: 0o600 })
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(backups(w)).toEqual([])
  expect(w.out.filter((line) => line.includes('plain-text backup of epoch 0') && line.endsWith('[done]'))).toHaveLength(2)
  expect(w.out.some((line) => line.includes(`remove ${join(w.dataDir, OLD_BACKUP)}: plain-text backup of epoch 0; the value is in keychain entry hmac-legacy`))).toBe(true)
  expect(keyBytes(w)).toEqual([])
  expect((await statusOut(w)).some((line) => line.includes('warning'))).toBe(false)
})

test('a backup that differs from hmac-legacy stays, with the reason and the rm command; status keeps warning', async () => {
  const w = oldUser()
  const old = join(w.dataDir, OLD_BACKUP)
  writeFileSync(old, OTHER, { mode: 0o600 })
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(backups(w)).toEqual([old])
  expect(w.out).toContain(`     kept ${old}: it differs from keychain entry hmac-legacy. Once that is fixed, delete it with: rm ${old}`)
  expect(keyBytes(w)).toEqual([])
  expect(await statusOut(w)).toContain(`  warning: plain-text key backup ${old}; delete it once you no longer need to roll back (rm ${old})`)
})

test('a failed keychain read-back keeps the backup', async () => {
  const w = oldUser()
  wrapSecurity(w, (inner) => (call) => (isLegacyRead(call.args) ? { exitCode: 36, stdout: '' } : inner(call)))
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const [backup] = backups(w)
  expect(readFileSync(backup!, 'utf8')).toBe(LEGACY)
  expect(statSync(backup!).mode & 0o777).toBe(0o600)
  expect(w.out).toContain(`     kept ${backup}: the keychain read-back of hmac-legacy failed (keychain lookup failed (exit 36)). Once that is fixed, delete it with: rm ${backup}`)
  expect((await statusOut(w)).some((line) => line.includes(`warning: plain-text key backup ${backup}`))).toBe(true)
})

test('a daemon that stops answering /health keeps the backup', async () => {
  const w = oldUser()
  let healthDown = false
  wrapSecurity(w, (inner) => (call) => ((healthDown ||= isLegacyRead(call.args)), inner(call)))
  const fetch = w.env.fetch
  w.env = { ...w.env, fetch: async (url, init) => (healthDown && url.endsWith('/health') ? Promise.reject(new TypeError('refused')) : fetch(url, init)) }
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const [backup] = backups(w)
  expect(backup).toBeDefined()
  expect(w.out.some((line) => line.startsWith(`     kept ${backup}: the daemon is not healthy (nothing answers on 127.0.0.1:`))).toBe(true)
})

test('a daemon that is not in master mode keeps the backup', async () => {
  const w = oldUser()
  // The master is stored, but the daemon's read of it is denied: degraded mode.
  wrapSecurity(w, (inner) => (call) => (call.args.includes('-w') && call.args.includes(HMAC_MASTER_REF) ? { exitCode: 36, stdout: '' } : inner(call)))
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(w.launchd.daemon?.hmacKeys.mode()).toBe('degraded')
  const [backup] = backups(w)
  expect(w.out).toContain(`     kept ${backup}: the daemon runs in degraded hmac mode, not master. Once that is fixed, delete it with: rm ${backup}`)
})

test('dry run shows the removal of this run\'s and older backups, and changes nothing', async () => {
  const w = oldUser()
  writeFileSync(join(w.dataDir, OLD_BACKUP), LEGACY, { mode: 0o600 })
  const before = snapshotTree(w.home)
  expect(await install(w.env, { ...YES, dryRun: true })).toBe(EXIT_OK)
  expect(snapshotTree(w.home)).toEqual(before)
  const removals = w.out.filter((line) => line.endsWith(': plain-text backup of epoch 0; the value is in keychain entry hmac-legacy'))
  expect(removals).toHaveLength(2)
  expect(removals[0]).toContain(OLD_BACKUP)
  expect(removals[1]).toMatch(/remove .*hmac\.key\.sam-backup-\d{8}T\d{6}Z: /)
  expect(w.securityCalls.filter((call) => call.args.includes('-w') || call.args[0] === '-i')).toEqual([])
})

async function migrated(): Promise<FakeWorld> {
  const w = oldUser()
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  w.out.length = 0
  w.securityCalls.length = 0
  return w
}

test('uninstall --remove-hmac-keys --dry-run shows restore, both deletes with the consequence, hmac.d; changes nothing', async () => {
  const w = await migrated()
  const before = snapshotTree(w.home)
  expect(await uninstall(w.env, { dryRun: true, removeCredentials: false, removeHmacKeys: true })).toBe(EXIT_OK)
  expect(snapshotTree(w.home)).toEqual(before)
  expect(w.keychain.has(HMAC_MASTER_REF) && w.keychain.has(HMAC_LEGACY_REF)).toBe(true)
  expect(w.securityCalls.filter((call) => call.args.includes('-w') || call.args[0] !== 'find-generic-password')).toEqual([])
  const plan = w.out.join('\n')
  expect(plan).toContain(`write ${legacyPath(w)} from keychain entry hmac-legacy (mode 0600), so a later install still verifies epoch-0 refs`)
  expect(plan).toContain('delete-generic-password -s shared-agent-memory -a hmac-master: the HMAC master; stored refs can no longer be checked, and a later install starts a new master')
  expect(plan).toContain(`delete-generic-password -s shared-agent-memory -a hmac-legacy: epoch 0's key; its value stays in ${legacyPath(w)}`)
  const files = worldSubKeyEpochs().length
  expect(plan).toContain(`remove ${subKeyDir(w.dataDir)}/: the marker sub-keys (${files} file${files === 1 ? '' : 's'}); stored refs can no longer be checked`)
  expect(plan).toContain(`a real run writes ${legacyPath(w)} from keychain entry hmac-legacy`)
})

test('uninstall --remove-hmac-keys restores hmac.key from hmac-legacy, deletes both entries and hmac.d; status after', async () => {
  const w = await migrated()
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false, removeHmacKeys: true })).toBe(EXIT_OK)
  expect(readFileSync(legacyPath(w), 'utf8')).toBe(LEGACY)
  expect(statSync(legacyPath(w)).mode & 0o777).toBe(0o600)
  expect(w.keychain.has(HMAC_MASTER_REF) || w.keychain.has(HMAC_LEGACY_REF)).toBe(false)
  expect(existsSync(subKeyDir(w.dataDir))).toBe(false)
  expect(w.out).toContain(`wrote ${legacyPath(w)} from keychain entry hmac-legacy, so a later install still verifies refs stored before the migration; if you do not want that, delete it yourself: rm ${legacyPath(w)}`)
  expect(w.out.some((line) => line.startsWith('kept keychain entry hmac-'))).toBe(false)
  expect(keyBytes(w)).toEqual([])
  expect(await statusOut(w)).toEqual([
    'hmac keys: hmac.key file (run sam install to move it to the keychain); keychain hmac-master missing, hmac-legacy missing',
    `  sub-keys in ${subKeyDir(w.dataDir)}: none`,
  ])
})

test('a failed restore stops uninstall before either entry is deleted', async () => {
  const w = await migrated()
  wrapSecurity(w, (inner) => (call) => (isLegacyRead(call.args) ? { exitCode: 36, stdout: '' } : inner(call)))
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false, removeHmacKeys: true })).toBe(EXIT_FAILED)
  expect(w.keychain.has(HMAC_MASTER_REF) && w.keychain.has(HMAC_LEGACY_REF)).toBe(true)
  expect(existsSync(subKeyDir(w.dataDir))).toBe(true)
})

test('--remove-credentials alone keeps the HMAC entries and hmac.d, as before', async () => {
  const w = await migrated()
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: true })).toBe(EXIT_OK)
  expect(w.keychain.has(HMAC_MASTER_REF) && w.keychain.has(HMAC_LEGACY_REF)).toBe(true)
  expect(existsSync(subKeyDir(w.dataDir))).toBe(true)
  expect(existsSync(legacyPath(w))).toBe(false)
  expect((await statusOut(w))[0]).toBe('hmac keys: keychain master; keychain hmac-master present, hmac-legacy present')
})

test('--remove-hmac-keys is an uninstall flag without a value; the usage line and help say what it costs', () => {
  expect(parseArgs(['uninstall', '--remove-hmac-keys'])).toMatchObject({ ok: true, value: { removeHmacKeys: true, removeCredentials: false } })
  expect(parseArgs(['uninstall', '--remove-hmac-keys=yes'])).toEqual({ ok: false, error: `unknown argument "--remove-hmac-keys=yes"\n${USAGE}` })
  expect(parseArgs(['install', '--remove-hmac-keys'])).toEqual({ ok: false, error: '--remove-hmac-keys does not apply to install' })
  expect(USAGE).toContain('uninstall  [--dry-run] [--remove-credentials] [--remove-hmac-keys]')
  expect(USAGE).toContain('stored refs can no longer')
  expect(USAGE).toContain('a later install starts a new master')
})

test('--remove-hmac-keys refuses while a hand-started daemon still answers /health; no HMAC key is touched', async () => {
  const w = await migrated()
  w.launchd.loaded = false // the daemon keeps running outside launchd, as one started by hand would
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false, removeHmacKeys: true })).toBe(EXIT_FAILED)
  expect(w.keychain.has(HMAC_MASTER_REF) && w.keychain.has(HMAC_LEGACY_REF)).toBe(true)
  expect(existsSync(subKeyDir(w.dataDir))).toBe(true)
  expect(existsSync(legacyPath(w))).toBe(false)
  const out = w.out.join('\n')
  expect(out).toContain('a daemon still answers /health on port')
  expect(out).toContain('no HMAC key was touched')
  expect(keyBytes(w)).toEqual([])
})

test('--remove-hmac-keys removes a kept backup equal to the restored hmac.key and keeps one that differs', async () => {
  const w = await migrated()
  const same = join(w.dataDir, OLD_BACKUP)
  const differs = join(w.dataDir, 'hmac.key.sam-backup-20260902T000000Z')
  writeFileSync(same, LEGACY, { mode: 0o600 })
  writeFileSync(differs, OTHER, { mode: 0o600 })
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false, removeHmacKeys: true })).toBe(EXIT_OK)
  expect(existsSync(same)).toBe(false)
  expect(readFileSync(differs, 'utf8')).toBe(OTHER)
  expect(w.out).toContain(`     kept ${differs}: it differs from ${legacyPath(w)}, so it may be the only copy of a key`)
  expect(keyBytes(w)).toEqual([])
})

test('--remove-hmac-keys --dry-run lists the daemon check first and the backup comparison, and changes nothing', async () => {
  const w = await migrated()
  writeFileSync(join(w.dataDir, OLD_BACKUP), LEGACY, { mode: 0o600 })
  const before = snapshotTree(w.home)
  expect(await uninstall(w.env, { dryRun: true, removeCredentials: false, removeHmacKeys: true })).toBe(EXIT_OK)
  expect(snapshotTree(w.home)).toEqual(before)
  const steps = w.out.filter((line) => /^\s+\d+\. /.test(line))
  const check = steps.findIndex((line) => line.includes('check that no daemon answers /health'))
  const restore = steps.findIndex((line) => line.includes('from keychain entry hmac-legacy'))
  expect(check).toBeGreaterThanOrEqual(0)
  expect(check).toBeLessThan(restore)
  expect(steps.some((line) => line.includes(`remove ${join(w.dataDir, OLD_BACKUP)} if it equals ${legacyPath(w)}`))).toBe(true)
})
