import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UNKEYED_EPOCH } from '../redaction/redact'
import { listSubKeyEpochs, loadMarkerKey, pickEpoch, readSubKey, subKeyDir, subKeyPath, writeSubKey } from './hmac-key'
import { posixOnly } from '../../test/platform-guards'

const OCT = Date.UTC(2026, 9, 26)
const key = (byte: string): string => byte.repeat(32)
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sam-hmac-key-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

posixOnly('file modes')('a sub-key file is written atomically, 0600 in a 0700 dir, and read back', () => {
  writeSubKey(dir, 202610, key('1a'))
  expect(readSubKey(dir, 202610)).toBe(key('1a'))
  expect(statSync(subKeyPath(dir, 202610)).mode & 0o777).toBe(0o600)
  expect(statSync(subKeyDir(dir)).mode & 0o777).toBe(0o700)
  writeSubKey(dir, 202610, key('2b'))
  expect(readSubKey(dir, 202610)).toBe(key('2b'))
  expect(readdirSync(subKeyDir(dir))).toEqual(['202610.key'])
  expect(readSubKey(dir, 202611)).toBeNull()
})

test('a file that is not a key throws with its path only', () => {
  writeSubKey(dir, 202610, key('1a'))
  writeFileSync(subKeyPath(dir, 202610), 'oops')
  expect(() => readSubKey(dir, 202610)).toThrow(`${subKeyPath(dir, 202610)} does not hold a 32-byte hex key`)
})

test('pickEpoch prefers the current epoch, then the newest before it, then the newest', () => {
  expect(pickEpoch([202609, 202610, 202611], 202610)).toBe(202610)
  expect(pickEpoch([202608, 202609, 202611], 202610)).toBe(202609)
  expect(pickEpoch([202611, 202612], 202610)).toBe(202612)
  expect(pickEpoch([], 202610)).toBeNull()
})

test('capture reads the current epoch\'s file, and the newest earlier one when the month has turned', () => {
  writeSubKey(dir, 202609, key('09'))
  writeSubKey(dir, 202610, key('10'))
  writeFileSync(join(subKeyDir(dir), 'notes.txt'), 'ignored')
  expect(listSubKeyEpochs(dir)).toEqual([202609, 202610])
  expect(loadMarkerKey(dir, OCT)).toEqual({ hmacKey: key('10'), epoch: 202610 })
  expect(loadMarkerKey(dir, Date.UTC(2026, 10, 2))).toEqual({ hmacKey: key('10'), epoch: 202610 })
  writeSubKey(dir, 202611, key('11'))
  expect(loadMarkerKey(dir, OCT)).toEqual({ hmacKey: key('10'), epoch: 202610 })
  expect(existsSync(join(dir, 'hmac.key'))).toBe(false)
})

posixOnly('file modes')('never migrated (no hmac.d): hmac.key is created and used as epoch 0, as before key rotation', () => {
  const first = loadMarkerKey(dir, OCT)
  expect(first.epoch).toBe(0)
  expect(statSync(join(dir, 'hmac.key')).mode & 0o777).toBe(0o600)
  expect(loadMarkerKey(dir, OCT)).toEqual(first)
})

test('an existing hmac.key with an empty hmac.d still serves epoch 0', () => {
  writeFileSync(join(dir, 'hmac.key'), key('ee'), { mode: 0o600 })
  mkdirSync(subKeyDir(dir), { mode: 0o700 })
  expect(loadMarkerKey(dir, OCT)).toEqual({ hmacKey: key('ee'), epoch: 0 })
})

test('migrated but no sub-key yet and no hmac.key: a throwaway key with x. refs, and nothing is created', () => {
  mkdirSync(subKeyDir(dir), { mode: 0o700 })
  const a = loadMarkerKey(dir, OCT)
  const b = loadMarkerKey(dir, OCT)
  expect(a.epoch).toBe(UNKEYED_EPOCH)
  expect(a.hmacKey).not.toBe(b.hmacKey)
  expect(existsSync(join(dir, 'hmac.key'))).toBe(false)
  expect(readdirSync(subKeyDir(dir))).toEqual([])
})

test('mayCreateLegacy false never starts an hmac.key, even with no hmac.d', () => {
  expect(loadMarkerKey(dir, OCT, { mayCreateLegacy: false }).epoch).toBe(UNKEYED_EPOCH)
  expect(existsSync(join(dir, 'hmac.key'))).toBe(false)
})
