// Notices for the updates levels: a release that waits for a yes is offered
// once its program is staged, with its change counts; at notify it is only
// told. Temp folders only.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseContextResult } from '../../../resources/context/types'
import { readInstallRecord } from '../../../resources/install-plan/setup/record'
import { bannerNotice, pendingNotice, takeNotice, updateCommand, userMessage } from '../../update/notice'
import { STAGE_DIR } from '../../update/stage'
import { type UpdateState, writeUpdateState } from '../../update/state'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-notice-levels-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const record = (fields: Record<string, unknown> = {}): void => {
  writeFileSync(join(dir, 'install.json'), JSON.stringify({ channel: 'curl', updateCheck: true, autoUpdate: true, firstInstalledAt: 1, ...fields }))
}
const release = (version: string, changes: string[] = ['A.', 'B.', 'BREAKING: C.'], breaking: string[] = ['BREAKING: C.']): UpdateState => ({
  lastAttemptAt: 1, latestVersion: version, checkedAt: 1, notified: {}, beta: version.includes('-'), release: { version, prerelease: version.includes('-'), changes, breaking },
})
// darwin arm64 has a release build; the staged file name follows the platform passed here, not the one running the test.
const STAGE = { dataDir: '', platform: 'darwin' as NodeJS.Platform, arch: 'arm64', capable: true }
const stage = () => ({ ...STAGE, dataDir: dir })
const DARWIN = { capable: false, now: 1, platform: 'darwin' as NodeJS.Platform, arch: 'arm64' }

function stageProgram(version: string): void {
  const folder = join(dir, STAGE_DIR)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, `kinfold-${version}`)
  writeFileSync(path, 'program')
  const stat = statSync(path)
  writeFileSync(join(folder, 'staged.json'), JSON.stringify({ staged: { version, asset: 'kinfold-darwin-arm64', sha256: 'a'.repeat(64), size: stat.size, mtimeMs: stat.mtimeMs, at: 1 }, failure: null }))
}

test('the offer names the release, its changes and the breaking count, and how to install it', () => {
  expect(userMessage({ kind: 'offer', version: '0.6.0', channel: 'curl', changes: 3, breaking: 1 })).toBe('Kinfold 0.6.0 is ready · 3 changes, 1 breaking · kinfold update to install')
  expect(userMessage({ kind: 'offer', version: '0.6.0', channel: 'curl', changes: 1, breaking: 0 })).toBe('Kinfold 0.6.0 is ready · 1 change · kinfold update to install')
  expect(userMessage({ kind: 'offer', version: '0.6.0', channel: 'curl', changes: 0, breaking: 0 })).toBe('Kinfold 0.6.0 is ready · no changelog for this release · kinfold update to install')
  // A state from before change lines knows no counts, which is not the same as a release with none.
  expect(userMessage({ kind: 'offer', version: '0.6.0', channel: 'curl' })).toBe('Kinfold 0.6.0 is ready · kinfold update to install')
})

test('a told release carries its counts when they are known', () => {
  expect(userMessage({ version: '0.6.0', channel: 'curl', changes: 2, breaking: 2 })).toBe('Kinfold 0.6.0 is available · 2 changes, 2 breaking. Run `kinfold update`.')
  expect(userMessage({ version: '0.6.0', channel: 'curl' })).toBe('Kinfold 0.6.0 is available. Run `kinfold update`.')
})

test('a beta installed through a launcher is fetched from its next tag', () => {
  expect(updateCommand('npx', true)).toBe('npx kinfold@next')
  expect(updateCommand('bunx', true)).toBe('bunx kinfold@next')
  expect(updateCommand('curl', true)).toBe('kinfold update')
  expect(userMessage({ kind: 'offer', version: '0.6.0-beta.1', channel: 'npx', changes: 0, breaking: 0, prerelease: true })).toContain('npx kinfold@next to install')
})

test('at the patch level a minor release is held until its program is staged, then offered', () => {
  record()
  expect(pendingNotice(release('0.6.0'), readInstallRecord(dir), '0.5.0', {}, undefined, stage())).toBeNull()
  stageProgram('0.6.0')
  expect(pendingNotice(release('0.6.0'), readInstallRecord(dir), '0.5.0', {}, undefined, stage())).toEqual({ kind: 'offer', version: '0.6.0', channel: 'curl', changes: 3, breaking: 1 })
})

test('a release whose staging failed, or that has no build here, is told as available', () => {
  record()
  mkdirSync(join(dir, STAGE_DIR), { recursive: true })
  writeFileSync(join(dir, STAGE_DIR, 'staged.json'), JSON.stringify({ staged: null, failure: { version: '0.6.0', checkedAt: 1, at: 1, reason: 'no' } }))
  expect(pendingNotice(release('0.6.0'), readInstallRecord(dir), '0.5.0', {}, undefined, stage())).toMatchObject({ version: '0.6.0', changes: 3 })
  expect(pendingNotice(release('0.7.0'), readInstallRecord(dir), '0.5.0', {}, undefined, { ...stage(), platform: 'freebsd' as NodeJS.Platform })).toMatchObject({ version: '0.7.0' })
})

test('at notify a minor release is told at once and never offered', () => {
  record({ updates: 'notify' })
  stageProgram('0.6.0')
  expect(pendingNotice(release('0.6.0'), readInstallRecord(dir), '0.5.0', {}, undefined, stage())).toEqual({ version: '0.6.0', channel: 'curl', changes: 3, breaking: 1 })
})

test('a beta is never told or offered while the beta channel is off', () => {
  record()
  stageProgram('0.6.0-beta.1')
  expect(pendingNotice(release('0.6.0-beta.1'), readInstallRecord(dir), '0.5.0', {}, undefined, stage())).toBeNull()
  record({ beta: true })
  expect(pendingNotice(release('0.6.0-beta.1'), { channel: 'curl', updateCheck: true, autoUpdate: true, autoUpdateIntro: false, beta: true, agentHomes: {}, firstInstalledAt: 1 }, '0.5.0', {}, undefined, stage())).toMatchObject({ kind: 'offer', prerelease: true })
})

test('each host is told of an offer once, and the dashboard banner keeps showing it', () => {
  record()
  writeUpdateState(dir, release('0.6.0'))
  stageProgram('0.6.0')
  expect(takeNotice(dir, 'claude-code', '0.5.0', {}, DARWIN)).toMatchObject({ kind: 'offer', version: '0.6.0' })
  expect(takeNotice(dir, 'claude-code', '0.5.0', {}, DARWIN)).toBeNull()
  expect(bannerNotice(dir, '0.5.0', {}, DARWIN)).toMatchObject({ kind: 'offer', version: '0.6.0' })
  expect(bannerNotice(dir, '0.5.0', {}, DARWIN)).toMatchObject({ kind: 'offer', version: '0.6.0' })
})

test('an offer travels to the hook with its counts, and a malformed count drops them', () => {
  const base = { text: '', observationIds: [], tokens: 0 }
  expect(parseContextResult({ ...base, selfNotice: { kind: 'offer', version: '0.6.0', channel: 'curl', changes: 3, breaking: 1, prerelease: true } })?.updateNotice).toEqual({ kind: 'offer', version: '0.6.0', channel: 'curl', changes: 3, breaking: 1, prerelease: true })
  expect(parseContextResult({ ...base, selfNotice: { kind: 'offer', version: '0.6.0', channel: 'curl', changes: -1, breaking: 'x' } })?.updateNotice).toEqual({ kind: 'offer', version: '0.6.0', channel: 'curl' })
  expect(parseContextResult({ ...base, updateNotice: { version: '0.6.0', channel: 'curl', changes: 2, breaking: 0 } })?.updateNotice).toEqual({ version: '0.6.0', channel: 'curl', changes: 2, breaking: 0 })
})

test('a release whose staging never reported back is told as available an hour after the check found it', () => {
  record()
  const state = { ...release('0.6.0'), checkedAt: 1_000 }
  expect(pendingNotice(state, readInstallRecord(dir), '0.5.0', {}, undefined, { ...stage(), now: 1_000 + 3_599_000 })).toBeNull()
  expect(pendingNotice(state, readInstallRecord(dir), '0.5.0', {}, undefined, { ...stage(), now: 1_000 + 3_600_001 })).toMatchObject({ version: '0.6.0' })
})
