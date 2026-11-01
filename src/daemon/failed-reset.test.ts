import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type TempStore, T0, fakeRunner, openTempStore, seedEvent, seedSession } from '../observer/test-support'
import type { CredentialProvider } from '../secrets/credentials'
import { LEGACY_FINGERPRINT_SCHEME, MASTER_FINGERPRINT_SCHEME } from '../secrets/fingerprint'
import { MAX_OBSERVER_ATTEMPTS } from '../store/observer-store'
import { startDaemon } from './daemon'
import { checkFailedResets } from './failed-reset'

const HMAC_KEY = 'ef'.repeat(32)
const LEGACY_KEY = { key: HMAC_KEY, scheme: LEGACY_FINGERPRINT_SCHEME }
const KEY_V1 = 'sk-or-v1-first-key-0000000000000000'
const KEY_V2 = 'sk-or-v1-second-key-111111111111111'

let temp: TempStore
let logs: string[]
let credential: string | null
const credentials: CredentialProvider = { get: () => credential }

beforeEach(() => {
  temp = openTempStore('sam-failed-reset-')
  logs = []
  credential = null
})
afterEach(() => temp.cleanup())

/** One opencode and one claude-code session, each with an exhausted failed event and one at attempt 1. */
function seedStuck(): { opencode: number; claude: number } {
  const opencode = seedSession(temp.store, 'opencode', 'oc-1')
  const claude = seedSession(temp.store, 'claude-code', 'cc-1')
  for (const session of [opencode, claude]) {
    seedEvent(temp.store, session, { kind: 'turn_end', at: T0 })
    seedEvent(temp.store, session, { kind: 'turn_end', at: T0 + 1 })
  }
  temp.store.db.run(`UPDATE events SET observer_state = 'failed', observer_attempts = ${MAX_OBSERVER_ATTEMPTS}, observer_retry_at = 1`)
  temp.store.db.run(`UPDATE events SET observer_attempts = 1 WHERE occurred_at = ${T0 + 1}`)
  return { opencode, claude }
}

const check = () => checkFailedResets({ db: temp.store.db, credentials, fingerprintKey: LEGACY_KEY, now: () => T0, log: (line) => logs.push(line) })
const states = (sessionId: number) =>
  temp.store.db.query(`SELECT observer_state AS state, observer_attempts AS attempts FROM events WHERE session_id = ${sessionId} ORDER BY occurred_at`).all()
const setSettings = (host: string, model: string) =>
  temp.store.db.query(
    `INSERT INTO observer_settings (host, provider, model, credential_ref, enabled, updated_at) VALUES ($host, 'openrouter', $model, NULL, 1, 1)
     ON CONFLICT (host) DO UPDATE SET model = excluded.model`,
  ).run({ host, model })

test('the first check records a baseline and resets nothing', () => {
  const { opencode } = seedStuck()
  expect(check()).toEqual([])
  expect(states(opencode)).toEqual([{ state: 'failed', attempts: 3 }, { state: 'failed', attempts: 1 }])
  expect(temp.store.db.query('SELECT host, credential FROM observer_fingerprints ORDER BY host').all()).toEqual([
    { host: 'claude-code', credential: 'none' },
    { host: 'opencode', credential: 'missing' },
  ])
})

test('an unchanged credential and unchanged settings reset nothing', () => {
  const { opencode } = seedStuck()
  credential = KEY_V1
  check()
  expect(check()).toEqual([])
  expect(states(opencode)[0]).toEqual({ state: 'failed', attempts: 3 })
})

test('a credential change resets that host\'s exhausted events only, attempts back to 0', () => {
  const { opencode, claude } = seedStuck()
  check()
  credential = KEY_V1
  expect(check()).toEqual([{ host: 'opencode', reason: 'credential', events: 1 }])
  expect(states(opencode)).toEqual([{ state: 'pending', attempts: 0 }, { state: 'failed', attempts: 1 }])
  expect(states(claude)[0]).toEqual({ state: 'failed', attempts: 3 })

  temp.store.db.run(`UPDATE events SET observer_state = 'failed', observer_attempts = ${MAX_OBSERVER_ATTEMPTS} WHERE session_id = ${opencode}`)
  credential = KEY_V2
  expect(check()).toEqual([{ host: 'opencode', reason: 'credential', events: 2 }])
  expect(logs).toContain('observer reset host=opencode reason=credential events=1')
})

test('a settings change for the host resets its exhausted events', () => {
  const { claude, opencode } = seedStuck()
  check()
  setSettings('claude-code', 'some/other-model')
  expect(check()).toEqual([{ host: 'claude-code', reason: 'settings+credential', events: 1 }])
  expect(states(claude)[0]).toEqual({ state: 'pending', attempts: 0 })
  expect(states(opencode)[0]).toEqual({ state: 'failed', attempts: 3 })

  temp.store.db.run(`UPDATE events SET observer_state = 'failed', observer_attempts = ${MAX_OBSERVER_ATTEMPTS} WHERE session_id = ${claude}`)
  setSettings('claude-code', 'a/third-model')
  expect(check()).toEqual([{ host: 'claude-code', reason: 'settings', events: 2 }])
})

test('neither the credential nor its fingerprint input reaches the store or the logs', () => {
  seedStuck()
  credential = KEY_V1
  check()
  credential = KEY_V2
  check()
  const stored = JSON.stringify(temp.store.db.query('SELECT * FROM observer_fingerprints').all())
  for (const secret of [KEY_V1, KEY_V2]) {
    expect(stored).not.toContain(secret)
    expect(logs.join('\n')).not.toContain(secret)
  }
})

test('a failing credential lookup is not a change: the host is skipped until the next check', () => {
  const { opencode } = seedStuck()
  credential = KEY_V1
  check()
  const broken: CredentialProvider = { get: () => { throw new Error('keychain locked') } }
  expect(checkFailedResets({ db: temp.store.db, credentials: broken, fingerprintKey: LEGACY_KEY, log: (line) => logs.push(line) })).toEqual([])
  expect(logs).toContain('observer reset check host=opencode skipped: credential lookup failed')
  expect(states(opencode)[0]).toEqual({ state: 'failed', attempts: 3 })
})

test('the daemon runs the check on start: a key added while it was down retries the stuck events', async () => {
  const { opencode } = seedStuck()
  const runner = fakeRunner([new Error('still failing')])
  const options = { runnerFor: () => runner, credentials, tickMs: 60_000, resetCheckMs: 60_000 }
  const first = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line), observer: options })
  await first.stop()
  credential = KEY_V1
  const second = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line), observer: options })
  await second.observer!.whenIdle()
  await second.stop()

  expect(logs).toContain('observer reset host=opencode reason=credential events=1')
  expect(states(opencode)[0]).not.toEqual({ state: 'failed', attempts: 3 })
})

test('while the fingerprint key is unknown (Keychain locked), credential hosts are skipped and nothing resets', () => {
  const { opencode } = seedStuck()
  credential = KEY_V1
  check()
  credential = KEY_V2
  expect(checkFailedResets({ db: temp.store.db, credentials, fingerprintKey: null, log: (line) => logs.push(line) })).toEqual([])
  expect(logs).toContain('observer reset check host=opencode skipped: hmac key unavailable')
  expect(states(opencode)[0]).toEqual({ state: 'failed', attempts: 3 })
})

test('moving from hmac.key to the master key re-baselines the fingerprint instead of resetting', () => {
  const { opencode } = seedStuck()
  credential = KEY_V1
  check()
  const master = { key: 'ab'.repeat(32), scheme: MASTER_FINGERPRINT_SCHEME }
  const underMaster = () => checkFailedResets({ db: temp.store.db, credentials, fingerprintKey: master, log: (line) => logs.push(line) })
  expect(underMaster()).toEqual([])
  expect(states(opencode)[0]).toEqual({ state: 'failed', attempts: 3 })
  const stored = temp.store.db.query("SELECT credential FROM observer_fingerprints WHERE host = 'opencode'").get() as { credential: string }
  expect(stored.credential).toStartWith(`${MASTER_FINGERPRINT_SCHEME}:`)
  credential = KEY_V2
  expect(underMaster()).toEqual([{ host: 'opencode', reason: 'credential', events: 1 }])
})
