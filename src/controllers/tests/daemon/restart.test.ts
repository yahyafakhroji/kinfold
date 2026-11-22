import { expect, test } from 'bun:test'
import { createRestarter } from '../../daemon/restart'

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

test('a restart asked for while another runs waits its turn: each core is stopped once and no second core opens beside the first', async () => {
  const stopped: string[] = []
  const steps: string[] = []
  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const r = rig(async (name) => {
    stopped.push(name)
  })
  const first = r.restarter.restart(async () => {
    steps.push('first starts')
    await held
    steps.push('first ends')
  })
  const second = r.restarter.restart(async () => {
    steps.push('second')
  })
  // The first step is still running: the second restart has stopped nothing and run nothing.
  await Promise.resolve()
  await Promise.resolve()
  expect(stopped).toEqual(['first'])
  expect(steps).toEqual(['first starts'])
  expect(r.restarter.down()).toBe(true)
  expect(r.restarter.inFlight()).not.toBeNull()

  release()
  await first
  // Still in flight: a stop that waits on inFlight() waits for the second one too.
  expect(r.restarter.inFlight()).not.toBeNull()
  await second
  expect(steps).toEqual(['first starts', 'first ends', 'second'])
  expect(stopped).toEqual(['first', 'core-1'])
  expect(r.current().name).toBe('core-2')
  expect(r.restarter.down()).toBe(false)
  expect(r.restarter.inFlight()).toBeNull()
})

test('after a fatal restart, one waiting behind it does not run: its step never touches the store and no core opens', async () => {
  const stopFailed = new Error('stop failed')
  let started = 0
  const stops: string[] = []
  const r = rig(async (name) => {
    stops.push(name)
    throw stopFailed
  }, () => {
    started += 1
    return { name: 'second', stop: async () => {} }
  })
  const first = r.restarter.restart(async () => {})
  let ran = false
  // Watched from the start, as its caller would: it is refused the moment the first one fails.
  const second = r.restarter.restart(async () => {
    ran = true
  }).then(() => 'ran', (error: Error) => error.message)
  await expect(first).rejects.toBe(stopFailed)
  expect(await second).toBe('the daemon is stopping after a failed restart')
  await expect(r.restarter.restart(async () => { ran = true })).rejects.toThrow('the daemon is stopping after a failed restart')
  expect(ran).toBe(false)
  expect(stops).toEqual(['first'])
  expect(started).toBe(0)
  expect(r.restarter.down()).toBe(true)
  expect(r.fatal).toHaveLength(1)
})

test('a restart that failed does not keep the next one from running', async () => {
  const r = rig(async () => {})
  const failed = new Error('restore failed')
  const first = r.restarter.restart(async () => { throw failed })
  let ran = false
  const second = r.restarter.restart(async () => {
    ran = true
  })
  await expect(first).rejects.toBe(failed)
  await second
  expect(ran).toBe(true)
  expect(r.current().name).toBe('core-2')
  expect(r.restarter.inFlight()).toBeNull()
})

test('a store that will not reopen is fatal, and down stays true: nothing has the store open', async () => {
  const r = rig(async () => {}, () => { throw new Error('locked') })
  await expect(r.restarter.restart(async () => {})).rejects.toThrow('locked')
  expect(r.restarter.down()).toBe(true)
  expect(r.fatal).toEqual(['memory.db could not be opened again (Error)'])
})
