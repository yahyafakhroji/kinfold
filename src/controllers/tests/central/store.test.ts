import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODE_PATTERN, proofKey, verifierFor } from '../../central/code'
import { INVITE_LIFE_MS, INVITE_TRIES, createInvite, redeemInvite } from '../../central/invites'
import { addDevice, findDevice, listDevices, removeDevice } from '../../central/devices'
import { CENTRAL_DIR } from '../../central/paths'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-central-store-'))
})
afterEach(() => {
  if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true })
})

const T0 = 1_700_000_000_000
const matches = (code: string) => (verifier: string, salt: string) => verifierFor(code, salt) === verifier && proofKey(verifier).length === 32

test('an invite keeps only a salt and verifier, owner-only, and the code works once', () => {
  const code = createInvite(dir, T0)
  expect(code).toMatch(CODE_PATTERN)
  const file = join(dir, CENTRAL_DIR, 'invites.json')
  const text = readFileSync(file, 'utf8')
  expect(text).not.toContain(code)
  expect(text).not.toContain(code.slice(3, 7))
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(redeemInvite(dir, T0 + 1000, matches(code))).toEqual({ ok: true })
  expect(redeemInvite(dir, T0 + 2000, matches(code))).toEqual({ ok: false, reason: 'no-invite' })
})

test('an invite is void after ten minutes', () => {
  const code = createInvite(dir, T0)
  expect(redeemInvite(dir, T0 + INVITE_LIFE_MS + 1, matches(code))).toEqual({ ok: false, reason: 'expired' })
  expect(existsSync(join(dir, CENTRAL_DIR, 'invites.json'))).toBe(false)
})

test('five wrong tries void the invite, and the right code then fails too', () => {
  const code = createInvite(dir, T0)
  for (let index = 0; index < INVITE_TRIES - 1; index += 1) expect(redeemInvite(dir, T0, matches('KF-0000-0000'))).toEqual({ ok: false, reason: 'wrong-code' })
  expect(redeemInvite(dir, T0, matches('KF-0000-0000'))).toEqual({ ok: false, reason: 'void' })
  expect(redeemInvite(dir, T0, matches(code))).toEqual({ ok: false, reason: 'no-invite' })
})

test('a new invite replaces the one before it', () => {
  const first = createInvite(dir, T0)
  const second = createInvite(dir, T0)
  expect(redeemInvite(dir, T0, matches(first))).toEqual({ ok: false, reason: 'wrong-code' })
  expect(redeemInvite(dir, T0, matches(second))).toEqual({ ok: true })
})

const device = { id: 'dev-a1', name: 'laptop', publicKey: 'PUB', nodeId: 'nNODE1', userId: '42', pairedAt: T0 }

test('paired devices are listed, found by id, and removed by id or name at once', () => {
  addDevice(dir, device)
  addDevice(dir, { ...device, id: 'dev-b2', name: 'desk' })
  expect(listDevices(dir).map((each) => each.id)).toEqual(['dev-a1', 'dev-b2'])
  expect(findDevice(dir, 'dev-a1')).toEqual(device)
  expect(removeDevice(dir, 'desk')).toEqual({ ...device, id: 'dev-b2', name: 'desk' })
  expect(findDevice(dir, 'dev-b2')).toBeNull()
  expect(removeDevice(dir, 'dev-a1')?.id).toBe('dev-a1')
  expect(removeDevice(dir, 'nothing')).toBeNull()
  expect(listDevices(dir)).toEqual([])
  const file = join(dir, CENTRAL_DIR, 'devices.json')
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
})

test('pairing the same device id again replaces its entry', () => {
  addDevice(dir, device)
  addDevice(dir, { ...device, publicKey: 'NEW' })
  expect(listDevices(dir)).toEqual([{ ...device, publicKey: 'NEW' }])
})

test('a devices file that does not parse lists nothing and finds nothing', async () => {
  addDevice(dir, device)
  await Bun.write(join(dir, CENTRAL_DIR, 'devices.json'), '{nope')
  expect(listDevices(dir)).toEqual([])
  expect(findDevice(dir, 'dev-a1')).toBeNull()
})
