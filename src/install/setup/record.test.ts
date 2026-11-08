import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { envName } from '../../env-names'
import { runPlan } from '../plan'
import { type FakeWorld, createWorld } from '../test-support'
import { INSTALL_RECORD_FILE, type InstallRecord, currentChannel, installRecordAction, readInstallRecord } from './record'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const RECORD: InstallRecord = { channel: 'curl', updateCheck: true, firstInstalledAt: 1_792_900_000_000 }
const programEnv = (w: FakeWorld, vars: Record<string, string> = {}): FakeWorld['env'] => ({ ...w.env, mode: { kind: 'program', binPath: join(w.dataDir, 'bin', 'kinfold') }, envVars: vars })

test('install.json round-trips at 0600', async () => {
  world = createWorld()
  mkdirSync(world.dataDir, { recursive: true })
  await runPlan(world.env, [installRecordAction(world.dataDir, RECORD)], false)
  const path = join(world.dataDir, INSTALL_RECORD_FILE)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')) as object)).toEqual(['channel', 'updateCheck', 'firstInstalledAt'])
  expect(readInstallRecord(world.dataDir)).toEqual(RECORD)
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

test('checkout mode is always checkout', () => {
  world = createWorld()
  const env = { ...world.env, envVars: { [envName('INSTALL_CHANNEL')]: 'npx' } }
  expect(currentChannel(env, RECORD)).toBe('checkout')
  expect(currentChannel(env, null)).toBe('checkout')
})
