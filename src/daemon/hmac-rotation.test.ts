import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeClaudeCode } from '../adapters/claude-code'
import { recordEvent } from '../cli/record'
import { ulid } from '../contract/ulid'
import { markerRefs, redactText, refMatches } from '../redaction/redact'
import type { CredentialProvider } from '../secrets/credentials'
import { credentialFingerprint } from '../secrets/fingerprint'
import { HMAC_LEGACY_REF, HMAC_MASTER_REF, epochAt, fingerprintKey, markerSubKey } from '../secrets/hmac-keys'
import { openTestDatabase } from '../sqlite/test-support'
import { listSubKeyEpochs, readSubKey, subKeyDir, subKeyPath, writeSubKey } from '../store/hmac-key'
import { startDaemon } from './daemon'
import { WRITE_AHEAD_MS, createHmacKeys, rotateSubKeys, wantedEpochs } from './hmac-rotation'

const MASTER = '3c'.repeat(32)
const LEGACY = '7d'.repeat(32)
const MID_OCT = Date.UTC(2026, 9, 15)
const OCT_30 = Date.UTC(2026, 9, 30, 12)
const NOV_2 = Date.UTC(2026, 10, 2)
const GITHUB = `ghp_${'a1B2c3D4'.repeat(5)}`

let dir: string
let logs: string[]
let clock: number
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sam-hmac-rotation-'))
  logs = []
  clock = MID_OCT
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A fake Keychain: reads only, and every read is counted. */
function keychain(values: Record<string, string>, failWith: Error | null = null): CredentialProvider & { reads: string[]; fail: Error | null } {
  const fake = {
    reads: [] as string[],
    fail: failWith,
    get: (ref: string): string | null => {
      fake.reads.push(ref)
      if (fake.fail !== null) throw fake.fail
      return values[ref] ?? null
    },
  }
  return fake
}
const keys = (provider: CredentialProvider) => createHmacKeys({ dataDir: dir, keychain: provider, now: () => clock, log: (line) => logs.push(line) })
const noKeyBytes = () => {
  const text = logs.join('\n')
  for (const secret of [MASTER, LEGACY, markerSubKey(MASTER, 202610), markerSubKey(MASTER, 202611)]) expect(text).not.toContain(secret)
}

test('rotation mid-month writes the current epoch only, derived from the master, 0600 in 0700', () => {
  expect(rotateSubKeys(dir, MASTER, MID_OCT)).toEqual({ current: 202610, written: [202610], deleted: [] })
  expect(readSubKey(dir, 202610)).toBe(markerSubKey(MASTER, 202610))
  expect(statSync(subKeyPath(dir, 202610)).mode & 0o777).toBe(0o600)
  expect(statSync(subKeyDir(dir)).mode & 0o777).toBe(0o700)
  expect(rotateSubKeys(dir, MASTER, MID_OCT)).toEqual({ current: 202610, written: [], deleted: [] })
  expect(readdirSync(subKeyDir(dir))).toEqual(['202610.key'])
})

test('in the last two days of a month the next epoch is written ahead', () => {
  expect(rotateSubKeys(dir, MASTER, OCT_30).written).toEqual([202610, 202611])
  expect(readSubKey(dir, 202611)).toBe(markerSubKey(MASTER, 202611))
})

test('after the month turns: current and previous stay, older and stray future files go, a bad file is rewritten', () => {
  for (const epoch of [202607, 202608, 202609, 202610, 202703]) writeSubKey(dir, epoch, markerSubKey(MASTER, epoch))
  writeSubKey(dir, 202610, '00'.repeat(32))
  expect(rotateSubKeys(dir, MASTER, NOV_2)).toEqual({ current: 202611, written: [202611], deleted: [202607, 202608, 202609, 202703] })
  expect(listSubKeyEpochs(dir)).toEqual([202610, 202611])
  expect(readSubKey(dir, 202610)).toBe('00'.repeat(32))
  expect(readdirSync(subKeyDir(dir)).filter((name) => name.includes('tmp'))).toEqual([])
})

test('master mode: one Keychain read at start, rotation on tick, fingerprints unchanged across epochs', () => {
  const provider = keychain({ [HMAC_MASTER_REF]: MASTER, [HMAC_LEGACY_REF]: LEGACY })
  const state = keys(provider)
  expect(state.mode()).toBe('master')
  expect(provider.reads).toEqual([HMAC_MASTER_REF])
  expect(state.marker()).toEqual({ hmacKey: markerSubKey(MASTER, 202610), epoch: 202610 })
  const before = credentialFingerprint(state.fingerprint()!.key, 'openrouter', 'sk-or-v1-x', state.fingerprint()!.scheme)
  clock = NOV_2
  state.tick()
  expect(state.marker().epoch).toBe(202611)
  expect(listSubKeyEpochs(dir)).toEqual([202610, 202611])
  expect(credentialFingerprint(state.fingerprint()!.key, 'openrouter', 'sk-or-v1-x', state.fingerprint()!.scheme)).toBe(before)
  expect(state.fingerprint()).toEqual({ key: fingerprintKey(MASTER), scheme: 'hmac-sha256-m1' })
  expect(provider.reads).toEqual([HMAC_MASTER_REF])
  expect(logs).toEqual(['hmac keys mode=master epoch=202610', 'hmac rotation epoch=202610 wrote=202610 deleted=none', 'hmac rotation epoch=202611 wrote=202611 deleted=none'])
  noKeyBytes()
})

test('clock skew across a boundary: refs from both epochs and from epoch 0 verify', () => {
  const provider = keychain({ [HMAC_MASTER_REF]: MASTER, [HMAC_LEGACY_REF]: LEGACY })
  clock = OCT_30
  const state = keys(provider)
  // A capture whose clock already reads November uses the written-ahead file; the daemon is still in October.
  const ahead = redactText(`t ${GITHUB}`, 'f', { hmacKey: readSubKey(dir, 202611)!, epoch: 202611 }).value
  const daemonSide = redactText(`t ${GITHUB}`, 'f', state.marker()).value
  const legacy = redactText(`t ${GITHUB}`, 'f', { hmacKey: LEGACY }).value
  const refs = [ahead, daemonSide, legacy].map((text) => markerRefs(text)[0]!)
  expect(refs.map((ref) => ref.epoch)).toEqual([202611, 202610, 0])
  for (const text of [ahead, daemonSide, legacy]) {
    const ref = /ref="([^"]+)"/.exec(text)![1]!
    expect(refMatches(GITHUB, ref, state.keyFor)).toBe(true)
    expect(refMatches(`ghp_${'a1b2'.repeat(9)}`, ref, state.keyFor)).toBe(false)
  }
  expect(provider.reads).toEqual([HMAC_MASTER_REF, HMAC_LEGACY_REF])
})

test('no master in the Keychain: legacy mode on hmac.key, exactly as before P1-J', () => {
  const state = keys(keychain({}))
  expect(state.mode()).toBe('legacy')
  const marker = state.marker()
  expect(marker.epoch).toBe(0)
  expect(readFileSync(join(dir, 'hmac.key'), 'utf8').trim()).toBe(marker.hmacKey)
  expect(state.fingerprint()).toEqual({ key: marker.hmacKey, scheme: 'hmac-sha256' })
  state.tick()
  expect(existsSync(subKeyDir(dir))).toBe(false)
  expect(logs).toEqual(['hmac keys mode=legacy'])
})

test('Keychain locked at start with a master present: serve on the newest file, never mint or create hmac.key, pause fingerprints, retry on tick', () => {
  writeSubKey(dir, 202609, markerSubKey(MASTER, 202609))
  const provider = keychain({ [HMAC_MASTER_REF]: MASTER }, new Error('keychain lookup failed (exit 36)'))
  const state = keys(provider)
  expect(state.mode()).toBe('degraded')
  expect(logs).toEqual(['hmac keychain unavailable class=exit_36; serving on existing key files'])
  expect(state.marker()).toEqual({ hmacKey: markerSubKey(MASTER, 202609), epoch: 202609 })
  expect(state.fingerprint()).toBeNull()
  state.tick()
  expect(logs).toHaveLength(1)
  expect(existsSync(join(dir, 'hmac.key'))).toBe(false)
  expect(listSubKeyEpochs(dir)).toEqual([202609])

  provider.fail = null
  state.tick()
  expect(state.mode()).toBe('master')
  expect(state.marker().epoch).toBe(202610)
  expect(listSubKeyEpochs(dir)).toEqual([202609, 202610])
  noKeyBytes()
})

test('locked with no key file at all: x. refs, and still no hmac.key', () => {
  const state = keys(keychain({}, new Error('keychain lookup failed (exit 51)')))
  expect(state.marker().epoch).toBe(-1)
  expect(existsSync(join(dir, 'hmac.key'))).toBe(false)
})

test('a daemon with a master writes the sub-key at start; capture then stores epoch-tagged refs', async () => {
  const dataDir = join(dir, 'data')
  const provider = keychain({ [HMAC_MASTER_REF]: MASTER })
  const daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line), keychain: provider })
  try {
    const epoch = epochAt(Date.now())
    expect(readSubKey(dataDir, epoch)).toBe(markerSubKey(MASTER, epoch))
    expect(existsSync(join(dataDir, 'hmac.key'))).toBe(false)
    const recorded = JSON.parse(readFileSync(join(import.meta.dir, '../../test/fixtures/claude-code/post-tool-use.bash.json'), 'utf8'))
    const payload = { ...recorded, cwd: dir, tool_response: { ...recorded.tool_response, stdout: `token ${GITHUB}` } }
    const event = normalizeClaudeCode(payload, { now: () => Date.now(), newId: () => ulid() })!
    await recordEvent(event, dataDir)
    daemon.scheduler.request()
    await daemon.scheduler.whenIdle()
    const db = openTestDatabase(join(dataDir, 'memory.db'), { readonly: true })
    const stored = (db.query('SELECT payload FROM events').all() as { payload: string }[]).map((row) => row.payload).join('\n')
    db.close()
    expect(stored).not.toContain(GITHUB)
    expect(stored).toContain(`ref=\\"e${epoch}.`)
    expect(provider.reads).toEqual([HMAC_MASTER_REF])
  } finally {
    await daemon.stop()
  }
  noKeyBytes()
})

test('next month joins the wanted epochs only in the last WRITE_AHEAD_MS of this one', () => {
  const november = Date.UTC(2026, 10, 1)
  expect(wantedEpochs(Date.UTC(2026, 9, 15))).toEqual([epochAt(Date.UTC(2026, 9, 15))])
  expect(wantedEpochs(november - WRITE_AHEAD_MS - 1)).toHaveLength(1)
  expect(wantedEpochs(november - WRITE_AHEAD_MS)).toEqual([epochAt(november - 1), epochAt(november)])
})
