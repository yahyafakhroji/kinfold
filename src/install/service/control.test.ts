import { afterEach, expect, test } from 'bun:test'
import { type FakeWorld, createWorld } from '../test-support'
import { serviceFor } from './control'
import { StubService } from './stub-service'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

test('serviceFor picks the platform service', () => {
  world = createWorld()
  const env = world.env
  expect(serviceFor(env).label).toBe('LaunchAgent')
  expect(serviceFor({ ...env, platform: 'linux' }).label).toBe('systemd user service')
  expect(serviceFor({ ...env, platform: 'linux', wsl: true }).label).toBe('systemd user service')
  expect(serviceFor({ ...env, platform: 'win32' }).label).toBe('scheduled task')
  expect(serviceFor(env).unavailableReason()).toBeNull()
})

test('a stub service refuses with the fixed message', async () => {
  world = createWorld({ platform: 'linux' })
  const service = new StubService(world.env, 'test service')
  const refusal = 'test service: not supported on this platform yet'
  await expect(service.start()).rejects.toThrow(refusal)
  await expect(service.stop()).rejects.toThrow(refusal)
  expect(service.describe('start')).toBe(refusal)
  expect(service.describe('stop')).toBe(refusal)
  expect(service.isConfigured()).toBe(false)
  expect(await service.isRunning()).toBe(false)
  expect(service.configPath()).toBeNull()
  expect(service.configContent(37_811)).toBeNull()
  expect(service.configuredDataDir()).toBeNull()
  expect(service.configuredPort()).toBeNull()
  expect(await service.fileHolders('/x/memory.db')).toBe('')
  expect(service.unavailableReason()).toBe('not set up on this platform yet')
  expect(world.commands).toEqual([])
})
