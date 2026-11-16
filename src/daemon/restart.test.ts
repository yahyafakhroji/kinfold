import { expect, test } from 'bun:test'
import { createRestarter } from './restart'

interface FakeCore {
  name: string
  stop(): Promise<void>
}

function rig(stopOf: (name: string) => Promise<void>, start?: () => FakeCore) {
  let made = 0
  const core = (name: string): FakeCore => ({ name, stop: () => stopOf(name) })
  let current = core('first')
  const fatal: string[] = []
  const restarter = createRestarter<FakeCore>({ current: () => current, start: start ?? (() => core(`core-${++made}`)), adopt: (next) => { current = next }, onFatal: (reason) => fatal.push(reason) })
  return { restarter, fatal, current: () => current }
}

test('a stop that rejects is fatal: the step does not run, no second core opens beside the old one, and the error reaches the caller', async () => {
  const stopFailed = new Error('stop failed')
  let started = 0
  const r = rig(async (name) => {
    if (name === 'first') throw stopFailed
  }, () => {
    started += 1
    return { name: 'second', stop: async () => {} }
  })
  let ran = false
  const run = r.restarter.restart(async () => {
    ran = true
  })
  expect(r.restarter.down()).toBe(true)
  await expect(run).rejects.toBe(stopFailed)
  expect(ran).toBe(false)
  expect(started).toBe(0)
  expect(r.current().name).toBe('first')
  expect(r.fatal).toEqual(['the store could not be closed for the restore (Error)'])
  expect(r.restarter.inFlight()).toBeNull()
})

test('a step that fails still reopens the store, and down is false again', async () => {
  const r = rig(async () => {})
  const failed = new Error('restore failed')
  await expect(r.restarter.restart(async () => { throw failed })).rejects.toBe(failed)
  expect(r.restarter.down()).toBe(false)
  expect(r.current().name).toBe('core-1')
})

test('a store that will not reopen is fatal, and down stays true: nothing has the store open', async () => {
  const r = rig(async () => {}, () => { throw new Error('locked') })
  await expect(r.restarter.restart(async () => {})).rejects.toThrow('locked')
  expect(r.restarter.down()).toBe(true)
  expect(r.fatal).toEqual(['memory.db could not be opened again (Error)'])
})
