import { expect, test } from 'bun:test'
import { deviceNotice } from './central'
import type { CentralStatus } from './types'

type Device = Extract<CentralStatus, { role: 'device' }>
const device = (change: Partial<Device> = {}): Device => ({
  role: 'device', hub: 'mac-mini', address: 'x', deviceId: 'dev-a', reachable: true, failure: null, problem: null, queued: 0, lastContactAt: 1, ...change,
})

test('a connected device needs no notice', () => {
  expect(deviceNotice(device())).toBeNull()
})

test('a hub that answered too late is busy, a warning, never "cannot reach"', () => {
  const notice = deviceNotice(device({ reachable: false, failure: 'timeout', problem: "mac-mini is busy and didn't answer in time", queued: 0 }))
  expect(notice).toEqual({ tone: 'warn', text: "mac-mini is busy and didn't answer in time; Kinfold asks again. Captures wait here (0 events) and are sent when it answers." })
})

test('no route to the hub is "cannot reach"', () => {
  const notice = deviceNotice(device({ reachable: false, failure: 'unreachable', problem: 'could not reach the hub mac-mini', queued: 3 }))
  expect(notice).toEqual({ tone: 'bad', text: 'This device cannot reach mac-mini: could not reach the hub mac-mini. Captures wait here (3 events) and are sent when it is back.' })
})

test('a refusal (pairing, sign-in, version) names the reason, not reachability', () => {
  expect(deviceNotice(device({ reachable: false, failure: 'refused', problem: 'mac-mini refused this device', queued: 1 }))).toEqual({
    tone: 'bad', text: 'mac-mini turned this device away: mac-mini refused this device. Captures wait here (1 event) and are sent once that is fixed.',
  })
  // A version gap: the hub answered, so reachable stays true, and still nothing is stored.
  expect(deviceNotice(device({ reachable: true, failure: 'version', problem: 'update this device to 0.7.0' }))?.text).toStartWith('mac-mini turned this device away: update this device to 0.7.0.')
})

test('a daemon from before the failure field still gets the old notice', () => {
  const { failure: _none, ...old } = device({ reachable: false, problem: null, queued: 2 })
  expect(deviceNotice(old as Device)?.text).toBe('This device cannot reach mac-mini. Captures wait here (2 events) and are sent when it is back.')
})

test('a hub that answered with an error is said to have had an error, not to be out of reach', () => {
  expect(deviceNotice(device({ reachable: true, failure: 'hub-error', problem: 'mac-mini had an error answering (its daemon log says why)', queued: 1 }))).toEqual({
    tone: 'bad', text: 'mac-mini had an error answering (its daemon log says why). Captures wait here (1 event) and are sent once it answers.',
  })
})
