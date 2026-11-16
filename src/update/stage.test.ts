import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { posixOnly } from '../../test/platform-guards'
import { RELEASE_BASE } from '../install/self-install'
import { STAGE_DIR, type StageDeps, readStageRecord, removeStaged, runStageTick, stageDecision, stagedProgram } from './stage'
import { writeUpdateState } from './state'

const ASSET = 'kinfold-darwin-arm64'
const T0 = 1_800_000_000_000
const PROGRAM = new TextEncoder().encode('#!/bin/sh\necho new kinfold\n')
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

let dir: string
let fetched: string[]
let routes: Record<string, () => Response>
let logs: string[]

const sumsFor = (version: string, bytes: Uint8Array = PROGRAM): Record<string, () => Response> => ({
  [`${RELEASE_BASE}/v${version}/SHA256SUMS`]: () => new Response(`${sha(bytes)}  ${ASSET}\n`),
  [`${RELEASE_BASE}/v${version}/${ASSET}`]: () => new Response(PROGRAM),
})

function deps(extra: Partial<StageDeps> = {}): StageDeps {
  return {
    dataDir: dir,
    version: '0.5.0',
    platform: 'darwin',
    arch: 'arm64',
    fetch: async (url) => {
      fetched.push(url)
      const route = routes[url]
      return route === undefined ? new Response('missing', { status: 404 }) : route()
    },
    envVars: () => ({}),
    now: () => T0,
    log: (line) => logs.push(line),
    ...extra,
  }
}

const record = (fields: Record<string, unknown> = {}): void => {
  writeFileSync(join(dir, 'install.json'), JSON.stringify({ channel: 'curl', updateCheck: true, autoUpdate: true, firstInstalledAt: 1, ...fields }))
}
const known = (version: string, checkedAt: number = T0): void => {
  writeUpdateState(dir, { lastAttemptAt: checkedAt, latestVersion: version, checkedAt, notified: {}, beta: version.includes('-'), release: { version, prerelease: version.includes('-'), changes: [], breaking: [] } })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-stage-'))
  fetched = []
  routes = sumsFor('0.6.0')
  logs = []
  record()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('a minor release is downloaded, checked and kept for a yes', async () => {
  known('0.6.0')
  expect(await runStageTick(deps())).toBe('staged')
  const staged = stagedProgram(dir, 'darwin')
  expect(staged).toMatchObject({ version: '0.6.0', sha256: sha(PROGRAM) })
  expect(readFileSync(staged!.path)).toEqual(Buffer.from(PROGRAM))
  expect(fetched).toEqual([`${RELEASE_BASE}/v0.6.0/SHA256SUMS`, `${RELEASE_BASE}/v0.6.0/${ASSET}`])
})

posixOnly('file modes')('the staged program is 0700 in a 0700 folder', async () => {
  known('0.6.0')
  await runStageTick(deps())
  expect(statSync(join(dir, STAGE_DIR)).mode & 0o777).toBe(0o700)
  expect(statSync(stagedProgram(dir, 'darwin')!.path).mode & 0o777).toBe(0o700)
})

test('a program that does not match SHA256SUMS is deleted, and the release is not tried again until the next check', async () => {
  known('0.6.0')
  routes = { ...sumsFor('0.6.0', new TextEncoder().encode('other bytes')) }
  expect(await runStageTick(deps())).toBe('failed')
  expect(stagedProgram(dir, 'darwin')).toBeNull()
  expect(readdirSync(join(dir, STAGE_DIR)).filter((name) => name.startsWith('kinfold-') || name.startsWith('.'))).toEqual([])
  expect(readStageRecord(dir).failure).toMatchObject({ version: '0.6.0', checkedAt: T0 })
  expect(await runStageTick(deps())).toBe('tried')
  known('0.6.0', T0 + 86_400_000)
  routes = sumsFor('0.6.0')
  expect(await runStageTick(deps())).toBe('staged')
})

test('a download past the size cap is refused and nothing is kept', async () => {
  known('0.6.0')
  expect(await runStageTick(deps({ maxProgramBytes: 4 }))).toBe('failed')
  expect(stagedProgram(dir, 'darwin')).toBeNull()
})

test('a newer release replaces the staged one', async () => {
  known('0.6.0')
  await runStageTick(deps())
  const old = stagedProgram(dir, 'darwin')!.path
  known('0.7.0')
  routes = sumsFor('0.7.0')
  expect(await runStageTick(deps())).toBe('staged')
  expect(stagedProgram(dir, 'darwin')?.version).toBe('0.7.0')
  expect(existsSync(old)).toBe(false)
})

test('a staged release is not downloaded again', async () => {
  known('0.6.0')
  await runStageTick(deps())
  fetched = []
  expect(await runStageTick(deps())).toBe('ready')
  expect(fetched).toEqual([])
})

test('a staged file that changed on disk is not the staged program', async () => {
  known('0.6.0')
  await runStageTick(deps())
  writeFileSync(stagedProgram(dir, 'darwin')!.path, 'tampered')
  expect(stagedProgram(dir, 'darwin')).toBeNull()
})

test('once the staged version is running, the staged program is removed', async () => {
  known('0.6.0')
  await runStageTick(deps())
  expect(await runStageTick(deps({ version: '0.6.0' }))).toBe('none')
  expect(stagedProgram(dir, 'darwin')).toBeNull()
  expect(existsSync(join(dir, STAGE_DIR, ASSET))).toBe(false)
})

const decide = (fields: { running?: string; level?: string; beta?: boolean; latest?: string | null; env?: Record<string, string> } = {}) => {
  record({ ...(fields.level !== undefined ? { updates: fields.level } : {}), ...(fields.beta === true ? { beta: true } : {}) })
  if (fields.latest !== null) known(fields.latest ?? '0.6.0')
  return stageDecision({ dataDir: dir, running: fields.running ?? '0.5.0', env: fields.env ?? {}, platform: 'darwin', arch: 'arm64' })
}

test('only the patch level stages, and only a release bigger than a patch', () => {
  expect(decide()).toMatchObject({ stage: true, version: '0.6.0' })
  expect(decide({ latest: '1.0.0' })).toMatchObject({ stage: true, version: '1.0.0' })
  expect(decide({ level: 'notify' })).toEqual({ stage: false, reason: 'off' })
  expect(decide({ level: 'off' })).toEqual({ stage: false, reason: 'off' })
  expect(decide({ latest: '0.5.1' })).toEqual({ stage: false, reason: 'none' })
  expect(decide({ latest: '0.5.0' })).toEqual({ stage: false, reason: 'none' })
  expect(decide({ latest: null })).toEqual({ stage: false, reason: 'none' })
})

test('a beta is staged only with the beta channel on, and never for a checkout build', () => {
  expect(decide({ latest: '0.6.0-beta.1' })).toEqual({ stage: false, reason: 'none' })
  expect(decide({ latest: '0.6.0-beta.1', beta: true })).toMatchObject({ stage: true, version: '0.6.0-beta.1' })
  expect(decide({ running: '0.0.0-dev' })).toEqual({ stage: false, reason: 'off' })
  writeFileSync(join(dir, 'install.json'), JSON.stringify({ channel: 'checkout', updateCheck: true, autoUpdate: true, firstInstalledAt: 1 }))
  expect(stageDecision({ dataDir: dir, running: '0.5.0', env: {}, platform: 'darwin', arch: 'arm64' })).toEqual({ stage: false, reason: 'off' })
})

test('a platform with no release build stages nothing', () => {
  known('0.6.0')
  expect(stageDecision({ dataDir: dir, running: '0.5.0', env: {}, platform: 'freebsd', arch: 'x64' })).toEqual({ stage: false, reason: 'no-build' })
})

test('removeStaged empties the folder of what staging wrote and leaves other files', async () => {
  known('0.6.0')
  await runStageTick(deps())
  mkdirSync(join(dir, STAGE_DIR, 'kept-folder'))
  removeStaged(dir)
  expect(stagedProgram(dir, 'darwin')).toBeNull()
  expect(readdirSync(join(dir, STAGE_DIR))).toEqual(['kept-folder'])
})

test('a staged beta is removed once the beta channel is off', async () => {
  record({ beta: true })
  known('0.6.0-beta.1')
  routes = sumsFor('0.6.0-beta.1')
  expect(await runStageTick(deps())).toBe('staged')
  record()
  await runStageTick(deps())
  expect(stagedProgram(dir, 'darwin')).toBeNull()
})
