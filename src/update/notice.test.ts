import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstallChannel, InstallRecord } from '../install/setup/record'
import { parseContextResult } from '../context/types'
import { runUpdateCheck } from './check'
import { agentLine, availableMessage, pendingNotice, takeNotice, updateCommand } from './notice'
import { UPDATE_STATE_FILE, markNotified, readUpdateState, writeUpdateState } from './state'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-notice-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const record = (channel: InstallChannel, updateCheck = true): InstallRecord => ({ channel, updateCheck, firstInstalledAt: 1 })
const writeRecord = (value: InstallRecord): void => writeFileSync(join(dir, 'install.json'), JSON.stringify(value))
const state = (latestVersion: string | null, notified: Record<string, string> = {}) => ({ lastAttemptAt: 1, latestVersion, checkedAt: 1, notified })

test('the wording follows the install channel', () => {
  expect(availableMessage({ version: '0.2.0', channel: 'npx' })).toBe('Kinfold 0.2.0 is available. Run `npx kinfold@latest`.')
  expect(availableMessage({ version: '0.2.0', channel: 'bunx' })).toBe('Kinfold 0.2.0 is available. Run `bunx kinfold@latest`.')
  expect(availableMessage({ version: '0.2.0', channel: 'curl' })).toBe('Kinfold 0.2.0 is available. Run `kinfold update`.')
  expect(availableMessage({ version: '0.2.0', channel: 'powershell' })).toBe('Kinfold 0.2.0 is available. Run `kinfold update`.')
  expect(updateCommand('checkout')).toBe('kinfold update')
  expect(agentLine({ version: '0.2.0', channel: 'npx' })).toBe('Kinfold 0.2.0 is out; you may tell the user they can run `npx kinfold@latest`.')
  expect(agentLine({ version: '0.2.0', channel: 'curl' })).toBe('Kinfold 0.2.0 is out; you may tell the user they can run `kinfold update`.')
})

test('an absent record reads as a curl install', () => {
  expect(pendingNotice(state('0.2.0'), null, '0.1.0', {})).toEqual({ version: '0.2.0', channel: 'curl' })
  expect(pendingNotice(state('0.2.0'), record('npx'), '0.1.0', {})).toEqual({ version: '0.2.0', channel: 'npx' })
})

test('no notice when the running version is current or newer', () => {
  expect(pendingNotice(state('0.2.0'), null, '0.2.0', {})).toBeNull()
  expect(pendingNotice(state('0.2.0'), null, '0.3.0', {})).toBeNull()
  expect(pendingNotice(state('0.2.0'), null, '0.2.0-rc.1', {})).not.toBeNull()
  expect(pendingNotice(state(null), null, '0.1.0', {})).toBeNull()
  expect(pendingNotice(state('0.2.0'), null, '0.0.0-dev', {})).toBeNull()
})

test('no notice when the check is off or this is a checkout', () => {
  expect(pendingNotice(state('0.2.0'), record('curl', false), '0.1.0', {})).toBeNull()
  expect(pendingNotice(state('0.2.0'), record('checkout'), '0.1.0', {})).toBeNull()
})

test('each host sees a version once', () => {
  writeUpdateState(dir, state('0.2.0'))
  expect(takeNotice(dir, 'claude-code', '0.1.0', {})).toEqual({ version: '0.2.0', channel: 'curl' })
  expect(takeNotice(dir, 'claude-code', '0.1.0', {})).toBeNull()
  expect(takeNotice(dir, 'codex', '0.1.0', {})).not.toBeNull()
  writeUpdateState(dir, { ...readUpdateState(dir), latestVersion: '0.3.0' })
  expect(takeNotice(dir, 'claude-code', '0.1.0', {})?.version).toBe('0.3.0')
  expect(readUpdateState(dir).notified).toEqual({ 'claude-code': '0.3.0', codex: '0.2.0' })
})

test('a notice marked during a slow check and the check result both survive', async () => {
  writeUpdateState(dir, state('0.2.0', {}))
  const T0 = 1_800_000_000_000
  const attempt = { ...readUpdateState(dir), lastAttemptAt: null }
  writeUpdateState(dir, attempt)
  const release = (resolve: (value: Response) => void): void => resolve(new Response(JSON.stringify({ tag_name: 'v0.3.0' })))
  let finish: () => void = () => undefined
  const slow = new Promise<Response>((resolve) => {
    finish = () => release(resolve)
  })
  const pending = runUpdateCheck({ dataDir: dir, version: '0.1.0', fetch: () => slow, now: () => T0, envVars: () => ({}), log: () => undefined })
  await Bun.sleep(20)
  markNotified(dir, 'claude-code', '0.2.0')
  finish()
  expect(await pending).toBe('checked')
  const after = readUpdateState(dir)
  expect(after.notified).toEqual({ 'claude-code': '0.2.0' })
  expect(after.latestVersion).toBe('0.3.0')
  expect(after.lastAttemptAt).toBe(T0)
  expect(after.checkedAt).toBe(T0)
  expect(UPDATE_STATE_FILE).toBe('update-check.json')
})

test('a record on disk picks the channel for the notice', () => {
  writeUpdateState(dir, state('0.2.0'))
  writeRecord(record('bunx'))
  expect(takeNotice(dir, 'cursor', '0.1.0', {})).toEqual({ version: '0.2.0', channel: 'bunx' })
})

test('parseContextResult keeps a valid notice and ignores a malformed one', () => {
  const base = { text: '', observationIds: [], tokens: 0 }
  expect(parseContextResult({ ...base, updateNotice: { version: '0.2.0', channel: 'npx' } })?.updateNotice).toEqual({ version: '0.2.0', channel: 'npx' })
  for (const bad of [{ version: 2, channel: 'npx' }, { version: '0.2.0', channel: 'checkout' }, { version: '0.2.0' }, 'x', { version: 'a b\n', channel: 'curl' }]) {
    const parsed = parseContextResult({ ...base, updateNotice: bad })
    expect(parsed).not.toBeNull()
    expect(parsed?.updateNotice).toBeUndefined()
  }
})

test('KINFOLD_NO_UPDATE_CHECK=1 silences the notice even with a newer version cached', () => {
  writeUpdateState(dir, state('0.2.0'))
  const off = { KINFOLD_NO_UPDATE_CHECK: '1' }
  expect(pendingNotice(state('0.2.0'), null, '0.1.0', off)).toBeNull()
  expect(takeNotice(dir, 'claude-code', '0.1.0', off)).toBeNull()
  expect(readUpdateState(dir).notified).toEqual({})
})
