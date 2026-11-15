import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { envName } from '../../env-names'
import { runPlan } from '../plan'
import { type FakeWorld, createWorld } from '../test-support'
import { AGENT_HOME_VARS, INSTALL_RECORD_FILE, type InstallRecord, agentHomesOf, applyAgentHomes, currentChannel, installRecordAction, readInstallRecord, setAutoUpdate, writeInstallRecord } from './record'
import { posixOnly } from '../../../test/platform-guards'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const RECORD: InstallRecord = { channel: 'curl', updateCheck: true, autoUpdate: true, autoUpdateIntro: false, agentHomes: {}, firstInstalledAt: 1_792_900_000_000 }
const programEnv = (w: FakeWorld, vars: Record<string, string> = {}): FakeWorld['env'] => ({ ...w.env, mode: { kind: 'program', binPath: join(w.dataDir, 'bin', 'kinfold') }, envVars: vars })

posixOnly('file modes')('install.json round-trips at 0600', async () => {
  world = createWorld()
  mkdirSync(world.dataDir, { recursive: true })
  await runPlan(world.env, [installRecordAction(world.dataDir, RECORD)], false)
  const path = join(world.dataDir, INSTALL_RECORD_FILE)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')) as object)).toEqual(['channel', 'updateCheck', 'autoUpdate', 'firstInstalledAt'])
  expect(readInstallRecord(world.dataDir)).toEqual(RECORD)
})

test('a record from before auto-update reads as on, with the one-time notice owed', () => {
  world = createWorld()
  mkdirSync(world.dataDir, { recursive: true })
  writeFileSync(join(world.dataDir, INSTALL_RECORD_FILE), JSON.stringify({ channel: 'curl', updateCheck: true, firstInstalledAt: 1_792_900_000_000 }))
  expect(readInstallRecord(world.dataDir)).toEqual({ ...RECORD, autoUpdate: true, autoUpdateIntro: true })
})

test('the owed notice is written only when owed, and survives a round trip', async () => {
  world = createWorld()
  mkdirSync(world.dataDir, { recursive: true })
  await runPlan(world.env, [installRecordAction(world.dataDir, { ...RECORD, autoUpdate: false, autoUpdateIntro: true })], false)
  const path = join(world.dataDir, INSTALL_RECORD_FILE)
  expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')) as object)).toEqual(['channel', 'updateCheck', 'autoUpdate', 'firstInstalledAt', 'autoUpdateIntro'])
  expect(readInstallRecord(world.dataDir)).toEqual({ ...RECORD, autoUpdate: false, autoUpdateIntro: true })
})

test('an autoUpdate that is not a boolean makes the record unreadable', () => {
  world = createWorld()
  mkdirSync(world.dataDir, { recursive: true })
  writeFileSync(join(world.dataDir, INSTALL_RECORD_FILE), JSON.stringify({ channel: 'curl', updateCheck: true, autoUpdate: 'yes', firstInstalledAt: 1 }))
  expect(readInstallRecord(world.dataDir)).toBeNull()
})

test('setAutoUpdate changes only that field and reports a missing record', async () => {
  world = createWorld()
  mkdirSync(world.dataDir, { recursive: true })
  expect(setAutoUpdate(world.dataDir, false)).toBe(false)
  await runPlan(world.env, [installRecordAction(world.dataDir, { ...RECORD, channel: 'npx', autoUpdateIntro: true })], false)
  expect(setAutoUpdate(world.dataDir, false)).toBe(true)
  expect(readInstallRecord(world.dataDir)).toMatchObject({ ...RECORD, channel: 'npx', autoUpdate: false, autoUpdateIntro: true })
  expect(setAutoUpdate(world.dataDir, true)).toBe(true)
  expect(readInstallRecord(world.dataDir)?.autoUpdate).toBe(true)
})

test('a malformed install.json reads as null', () => {
  world = createWorld()
  mkdirSync(world.dataDir, { recursive: true })
  const path = join(world.dataDir, INSTALL_RECORD_FILE)
  expect(readInstallRecord(world.dataDir)).toBeNull()
  for (const text of ['not json', 'null', '[]', '{}', JSON.stringify({ ...RECORD, channel: 'carrier-pigeon' }), JSON.stringify({ ...RECORD, updateCheck: 'yes' }), JSON.stringify({ ...RECORD, firstInstalledAt: 'now' })]) {
    writeFileSync(path, text)
    expect(readInstallRecord(world.dataDir)).toBeNull()
  }
})

test('channel from the launcher env wins over the saved one', () => {
  world = createWorld()
  const key = envName('INSTALL_CHANNEL')
  expect(currentChannel(programEnv(world, { [key]: 'npx' }), RECORD)).toBe('npx')
  expect(currentChannel(programEnv(world, { [key]: 'powershell' }), RECORD)).toBe('powershell')
  expect(currentChannel(programEnv(world), { ...RECORD, channel: 'bunx' })).toBe('bunx')
  expect(currentChannel(programEnv(world), null)).toBe('curl')
  // Only the four launcher names count; nothing can claim `checkout` or a made-up channel from outside.
  expect(currentChannel(programEnv(world, { [key]: 'checkout' }), RECORD)).toBe('curl')
  expect(currentChannel(programEnv(world, { [key]: 'smoke-signal' }), null)).toBe('curl')
  expect(currentChannel(programEnv(world, { SAM_INSTALL_CHANNEL: 'npx' }), null)).toBe('curl')
})

test('a saved checkout channel is ignored by a program', () => {
  world = createWorld()
  expect(currentChannel(programEnv(world), { ...RECORD, channel: 'checkout' })).toBe('curl')
})

test('checkout mode is always checkout', () => {
  world = createWorld()
  const env = { ...world.env, envVars: { [envName('INSTALL_CHANNEL')]: 'npx' } }
  expect(currentChannel(env, RECORD)).toBe('checkout')
  expect(currentChannel(env, null)).toBe('checkout')
})

// ---- agent homes, and the merge that keeps the newest auto-update choice ----

test('the agent home variables an install ran with are saved, and only those', async () => {
  world = createWorld()
  mkdirSync(world.dataDir, { recursive: true })
  const env = { ...world.env, codexHomeEnv: '/opt/codex-home', xdgConfigHomeEnv: '/home/u/.xdg', junieHomeEnv: '', copilotHomeEnv: undefined }
  expect(agentHomesOf(env)).toEqual({ CODEX_HOME: '/opt/codex-home', XDG_CONFIG_HOME: '/home/u/.xdg' })
  await runPlan(world.env, [installRecordAction(world.dataDir, { ...RECORD, agentHomes: agentHomesOf(env) })], false)
  const saved = JSON.parse(readFileSync(join(world.dataDir, INSTALL_RECORD_FILE), 'utf8')) as Record<string, unknown>
  expect(saved.agentHomes).toEqual({ CODEX_HOME: '/opt/codex-home', XDG_CONFIG_HOME: '/home/u/.xdg' })
  expect(readInstallRecord(world.dataDir)?.agentHomes).toEqual({ CODEX_HOME: '/opt/codex-home', XDG_CONFIG_HOME: '/home/u/.xdg' })
  expect([...AGENT_HOME_VARS]).toEqual(['CODEX_HOME', 'COPILOT_HOME', 'JUNIE_HOME', 'GEMINI_CLI_HOME', 'KIMI_CODE_HOME', 'XDG_CONFIG_HOME', 'CLINE_MCP_SETTINGS_PATH'])
})

test('only the known home variables are read back, and only plain path text', () => {
  world = createWorld()
  mkdirSync(world.dataDir, { recursive: true })
  const agentHomes = { CODEX_HOME: '/opt/codex', OPENROUTER_API_KEY: 'sk-never-a-home', JUNIE_HOME: 7, COPILOT_HOME: '/a\nb', GEMINI_CLI_HOME: '', KIMI_CODE_HOME: 'x'.repeat(5000) }
  writeFileSync(join(world.dataDir, INSTALL_RECORD_FILE), JSON.stringify({ channel: 'curl', updateCheck: true, autoUpdate: true, firstInstalledAt: 1, agentHomes }))
  expect(readInstallRecord(world.dataDir)?.agentHomes).toEqual({ CODEX_HOME: '/opt/codex' })
  writeFileSync(join(world.dataDir, INSTALL_RECORD_FILE), JSON.stringify({ channel: 'curl', updateCheck: true, autoUpdate: true, firstInstalledAt: 1, agentHomes: 'nope' }))
  expect(readInstallRecord(world.dataDir)?.agentHomes).toEqual({})
})

test('the updater\'s environment gets the saved homes, and a variable unset at install stays unset', () => {
  const vars: Record<string, string> = { PATH: '/usr/bin', JUNIE_HOME: '/stale/from/the/daemon', CODEX_HOME: '/also/stale' }
  expect(applyAgentHomes(vars, { CODEX_HOME: '/opt/codex-home', XDG_CONFIG_HOME: '/home/u/.xdg' })).toEqual({ PATH: '/usr/bin', CODEX_HOME: '/opt/codex-home', XDG_CONFIG_HOME: '/home/u/.xdg' })
  expect(vars.JUNIE_HOME).toBe('/stale/from/the/daemon')
})

test('a dashboard switch made while an install runs is kept: the newest choice wins the write', async () => {
  world = createWorld()
  mkdirSync(world.dataDir, { recursive: true })
  writeInstallRecord(world.dataDir, RECORD)
  // The install read the record (on), then the user switched it off in the dashboard, then the install wrote.
  const planned = installRecordAction(world.dataDir, { ...RECORD, channel: 'npx', updateCheck: false })
  expect(setAutoUpdate(world.dataDir, false, 5000)).toBe(true)
  await runPlan(world.env, [planned], false)
  expect(readInstallRecord(world.dataDir)).toMatchObject({ channel: 'npx', updateCheck: false, autoUpdate: false, autoUpdateAt: 5000 })
})

test('an install that chose auto-update itself, later than the switch, wins the write', async () => {
  world = createWorld()
  mkdirSync(world.dataDir, { recursive: true })
  writeInstallRecord(world.dataDir, RECORD)
  setAutoUpdate(world.dataDir, false, 5000)
  await runPlan(world.env, [installRecordAction(world.dataDir, { ...RECORD, autoUpdate: true, autoUpdateAt: 6000 })], false)
  expect(readInstallRecord(world.dataDir)).toMatchObject({ autoUpdate: true, autoUpdateAt: 6000 })
  await runPlan(world.env, [installRecordAction(world.dataDir, { ...RECORD, autoUpdate: false, autoUpdateAt: 4000 })], false)
  expect(readInstallRecord(world.dataDir)).toMatchObject({ autoUpdate: true, autoUpdateAt: 6000 })
})
