import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RunningDaemon, startDaemon } from '../daemon/daemon'
import { CHECK_INTERVAL_MS, LATEST_RELEASE_URL, MAX_RELEASE_BYTES, RELEASES_URL, type UpdateCheckDeps, runUpdateCheck } from './check'
import { UPDATE_STATE_FILE, knownRelease, readUpdateState, writeUpdateState } from './state'
import { posixOnly } from '../../test/platform-guards'

const HOUR = 3_600_000
const T0 = 1_800_000_000_000

let dir: string
let clock: number
let env: Record<string, string | undefined>
let logs: string[]
let calls: { url: string; init: RequestInit }[]
let respond: () => Promise<Response>

const release = (tag: string): Response => new Response(JSON.stringify({ tag_name: tag, draft: false, prerelease: false }))

function deps(): UpdateCheckDeps {
  return {
    dataDir: dir,
    version: '0.1.0',
    fetch: (url, init) => {
      calls.push({ url, init })
      return respond()
    },
    now: () => clock,
    envVars: () => env,
    log: (line) => logs.push(line),
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-update-'))
  clock = T0
  env = {}
  logs = []
  calls = []
  respond = async () => release('v0.2.0')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('the request carries only the user agent', async () => {
  await runUpdateCheck(deps())
  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toBe(LATEST_RELEASE_URL)
  expect(calls[0]!.url).not.toContain('?')
  expect(calls[0]!.init.headers).toEqual({ 'user-agent': 'kinfold-update-check' })
  expect(calls[0]!.init.body).toBeUndefined()
})

posixOnly('file modes')('a successful check records the version', async () => {
  expect(await runUpdateCheck(deps())).toBe('checked')
  const state = readUpdateState(dir)
  expect(state).toMatchObject({ latestVersion: '0.2.0', checkedAt: T0, lastAttemptAt: T0 })
  expect(statSync(join(dir, UPDATE_STATE_FILE)).mode & 0o777).toBe(0o600)
})

const failures: [string, () => Promise<Response>][] = [
  ['403', async () => new Response('rate limited', { status: 403 })],
  ['a network error', async () => Promise.reject(new TypeError('offline'))],
  ['malformed JSON', async () => new Response('{not json')],
  ['a body over the cap', async () => new Response(`{"tag_name":"v9.9.9","pad":"${'x'.repeat(MAX_RELEASE_BYTES)}"}`)],
]

for (const [name, failing] of failures) {
  test(`a failure records the attempt and keeps the last version: ${name}`, async () => {
    await runUpdateCheck(deps())
    clock = T0 + CHECK_INTERVAL_MS
    respond = failing
    expect(await runUpdateCheck(deps())).toBe('failed')
    expect(readUpdateState(dir)).toMatchObject({ latestVersion: '0.2.0', checkedAt: T0, lastAttemptAt: clock })
    expect(logs.join('\n')).toMatch(/^update check failed \(/)
    expect(logs.join('\n')).not.toContain('offline')
    calls = []
    clock += HOUR
    expect(await runUpdateCheck(deps())).toBe('not-due')
    expect(calls).toHaveLength(0)
  })
}

test('a failure on the very first check still records the attempt', async () => {
  respond = async () => new Response('', { status: 403 })
  expect(await runUpdateCheck(deps())).toBe('failed')
  expect(readUpdateState(dir)).toMatchObject({ latestVersion: null, checkedAt: null, lastAttemptAt: T0 })
  expect(logs).toEqual(['update check failed (403)'])
})

test('at most once a day', async () => {
  await runUpdateCheck(deps())
  calls = []
  clock = T0 + 23 * HOUR
  expect(await runUpdateCheck(deps())).toBe('not-due')
  expect(calls).toHaveLength(0)
  clock = T0 + 24 * HOUR
  expect(await runUpdateCheck(deps())).toBe('checked')
  expect(calls).toHaveLength(1)
})

test('the env var is read on every run', async () => {
  await runUpdateCheck(deps())
  calls = []
  env = { KINFOLD_NO_UPDATE_CHECK: '1' }
  clock = T0 + 25 * HOUR
  expect(await runUpdateCheck(deps())).toBe('disabled')
  expect(calls).toHaveLength(0)
})

test('the SAM_ name is not an off switch', async () => {
  env = { SAM_NO_UPDATE_CHECK: '1' }
  expect(await runUpdateCheck(deps())).toBe('checked')
})

test('install.json can turn the check off, and a checkout never checks', async () => {
  const record = (channel: string, updateCheck: boolean): void =>
    writeFileSync(join(dir, 'install.json'), JSON.stringify({ channel, updateCheck, firstInstalledAt: 1 }))
  record('curl', false)
  expect(await runUpdateCheck(deps())).toBe('disabled')
  record('checkout', true)
  expect(await runUpdateCheck(deps())).toBe('disabled')
  record('curl', true)
  expect(await runUpdateCheck(deps())).toBe('checked')
  expect(await runUpdateCheck({ ...deps(), version: '0.0.0-dev' })).toBe('disabled')
})

test('without the beta channel, a prerelease answer is not a usable release', async () => {
  respond = async () => new Response(JSON.stringify({ tag_name: 'v0.3.0-rc.1', draft: false, prerelease: true }))
  expect(await runUpdateCheck(deps())).toBe('failed')
  expect(readUpdateState(dir).latestVersion).toBeNull()
})

test('a damaged state file reads as empty and keeps notices it can parse', () => {
  writeFileSync(join(dir, UPDATE_STATE_FILE), '{oops')
  expect(readUpdateState(dir)).toEqual({ lastAttemptAt: null, latestVersion: null, checkedAt: null, notified: {}, beta: null, release: null })
  writeUpdateState(dir, { lastAttemptAt: 1, latestVersion: '0.2.0', checkedAt: 1, notified: { cli: '0.2.0' } })
  expect(readUpdateState(dir).notified).toEqual({ cli: '0.2.0' })
  expect(JSON.parse(readFileSync(join(dir, UPDATE_STATE_FILE), 'utf8')).latestVersion).toBe('0.2.0')
})

test('startup is not delayed', async () => {
  let fetchCalled = false
  let daemon: RunningDaemon | undefined
  try {
    daemon = startDaemon({
      dataDir: join(dir, 'data'),
      port: 0,
      version: '0.1.0',
      fallbackDrainMs: 60_000,
      log: () => undefined,
      updateCheck: {
        fetch: () => {
          fetchCalled = true
          return new Promise<Response>(() => undefined)
        },
        envVars: () => ({}),
      },
    })
    expect(fetchCalled).toBe(false)
    const response = await fetch(`http://127.0.0.1:${daemon.port}/health`)
    expect(response.status).toBe(200)
    await Bun.sleep(50)
    expect(fetchCalled).toBe(true)
  } finally {
    await daemon?.stop()
  }
})

const writeRecord = (fields: Record<string, unknown>): void => {
  writeFileSync(join(dir, 'install.json'), JSON.stringify({ channel: 'curl', updateCheck: true, autoUpdate: true, firstInstalledAt: 1, ...fields }))
}

test('the beta channel reads the release list and keeps the newest prerelease', async () => {
  writeRecord({ beta: true })
  respond = async () => new Response(JSON.stringify([
    { tag_name: 'v0.3.0-beta.1', draft: false, prerelease: true, body: '## Changes\n\n### Minor Changes\n\n- abcdef1: Beta thing.\n' },
    { tag_name: 'v0.2.0', draft: false, prerelease: false, body: '' },
    { tag_name: 'v0.4.0', draft: false, prerelease: true, body: '' },
  ]))
  expect(await runUpdateCheck(deps())).toBe('checked')
  expect(calls[0]!.url).toBe(RELEASES_URL)
  expect(readUpdateState(dir)).toMatchObject({ latestVersion: '0.3.0-beta.1', beta: true, release: { version: '0.3.0-beta.1', prerelease: true, changes: ['Beta thing.'], breaking: [] } })
})

test('a check keeps the release change lines next to the version', async () => {
  respond = async () => new Response(JSON.stringify({ tag_name: 'v0.3.0', draft: false, prerelease: false, body: '## Changes\n\n### Major Changes\n\n- abcdef1: Gone.\n- abcdef2: BREAKING: moved.\n' }))
  await runUpdateCheck(deps())
  expect(readUpdateState(dir).release).toEqual({ version: '0.3.0', prerelease: false, changes: ['Gone.', 'BREAKING: moved.'], breaking: ['Gone.', 'BREAKING: moved.'] })
})

test('a release list with nothing usable is a failed check', async () => {
  writeRecord({ beta: true })
  respond = async () => new Response(JSON.stringify([{ tag_name: 'v0.4.0', draft: false, prerelease: true }]))
  expect(await runUpdateCheck(deps())).toBe('failed')
})

test('changing the beta channel makes the check due again at once', async () => {
  await runUpdateCheck(deps())
  clock += HOUR
  writeRecord({ beta: true })
  respond = async () => new Response(JSON.stringify([{ tag_name: 'v0.3.0-beta.1', draft: false, prerelease: true }]))
  expect(await runUpdateCheck(deps())).toBe('checked')
  expect(readUpdateState(dir).latestVersion).toBe('0.3.0-beta.1')
})

test('a saved prerelease is not offered once the beta channel is off', () => {
  writeUpdateState(dir, { ...readUpdateState(dir), latestVersion: '0.3.0-beta.1', checkedAt: T0, lastAttemptAt: T0, beta: true, release: { version: '0.3.0-beta.1', prerelease: true, changes: [], breaking: [] } })
  expect(knownRelease(readUpdateState(dir), false)).toBeNull()
  expect(knownRelease(readUpdateState(dir), true)?.version).toBe('0.3.0-beta.1')
})

test('a state from before release lines knows the version alone', () => {
  writeFileSync(join(dir, UPDATE_STATE_FILE), JSON.stringify({ lastAttemptAt: T0, latestVersion: '0.3.0', checkedAt: T0, notified: {} }))
  expect(knownRelease(readUpdateState(dir), false)).toEqual({ version: '0.3.0', prerelease: false, changes: [], breaking: [] })
})
