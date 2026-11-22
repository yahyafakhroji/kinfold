import { expect, test } from 'bun:test'
import type { CredentialProvider } from './credentials'
import { HMAC_MASTER_REF, epochAt, epochStart, errorClassOf, fingerprintKey, isEpoch, markerSubKey, nextEpoch, previousEpoch, readMaster } from './hmac-keys'

const MASTER = '5a'.repeat(32)
const OTHER = 'a5'.repeat(32)

test('a sub-key is stable for one master and epoch, and differs across epochs and masters', () => {
  expect(markerSubKey(MASTER, 202610)).toBe(markerSubKey(MASTER, 202610))
  expect(markerSubKey(MASTER, 202610)).toMatch(/^[0-9a-f]{64}$/)
  expect(markerSubKey(MASTER, 202611)).not.toBe(markerSubKey(MASTER, 202610))
  expect(markerSubKey(OTHER, 202610)).not.toBe(markerSubKey(MASTER, 202610))
  expect(markerSubKey(MASTER, 202610)).not.toContain(MASTER)
})

test('the fingerprint purpose key is separate from every marker key and does not depend on the epoch', () => {
  const purpose = fingerprintKey(MASTER)
  expect(purpose).toBe(fingerprintKey(MASTER))
  for (const epoch of [202512, 202601, 202610, 202611]) expect(markerSubKey(MASTER, epoch)).not.toBe(purpose)
  expect(fingerprintKey(OTHER)).not.toBe(purpose)
})

test('only YYYYMM epochs get a sub-key', () => {
  for (const bad of [0, -1, 202600, 202613, 2026.5]) expect(() => markerSubKey(MASTER, bad)).toThrow('YYYYMM')
})

test('epochs are UTC months, and month arithmetic crosses years', () => {
  expect(epochAt(Date.UTC(2026, 9, 26, 12))).toBe(202610)
  expect(epochAt(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe(202612)
  expect(epochAt(Date.UTC(2027, 0, 1))).toBe(202701)
  expect(nextEpoch(202612)).toBe(202701)
  expect(previousEpoch(202701)).toBe(202612)
  expect(nextEpoch(202610)).toBe(202611)
  expect(epochStart(202611)).toBe(Date.UTC(2026, 10, 1))
  expect([isEpoch(202610), isEpoch(202613), isEpoch(0)]).toEqual([true, false, false])
})

test('readMaster: present, missing, locked or malformed; the error class never carries output', () => {
  const answer = (value: string | null): CredentialProvider => ({ get: (ref) => (ref === HMAC_MASTER_REF ? value : null) })
  expect(readMaster(answer(MASTER))).toEqual({ state: 'present', master: MASTER })
  expect(readMaster(answer(null))).toEqual({ state: 'missing' })
  expect(readMaster(answer('not-a-key'))).toEqual({ state: 'unavailable', errorClass: 'malformed' })
  const locked: CredentialProvider = { get: () => { throw new Error('keychain lookup failed (exit 36)') } }
  expect(readMaster(locked)).toEqual({ state: 'unavailable', errorClass: 'exit_36' })
  expect(errorClassOf(new TypeError('anything'))).toBe('TypeError')
})
