// The keys behind redaction marker refs, as files in the 0700 data directory.
// Before key rotation one 0600 file, hmac.key, held the only key. Now the daemon
// derives a sub-key per epoch from a Keychain master and writes it to
// hmac.d/<YYYYMM>.key (0600, atomic), so the capture hook (record.ts, which
// the OpenCode plugin also uses) does one small file read: no spawn, no IPC,
// no Keychain. A Keychain lookup measured p50 22 ms / p95 81 ms against the
// hook's 50 ms budget. The order loadMarkerKey follows:
//   1. the sub-key of the current epoch, else the newest one before it, else the newest;
//   2. hmac.key, epoch 0 (not migrated, or rolled back);
//   3. no hmac.d at all: never migrated, so create hmac.key as before key rotation;
//   4. hmac.d exists but holds nothing: a throwaway key with `x.` refs. Creating
//      hmac.key here would silently start a second epoch 0.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { type MarkerKey, UNKEYED_EPOCH } from '../redaction/redact'
import { LEGACY_EPOCH, epochAt, isEpoch, isHexKey } from '../secrets/hmac-keys'
import { DATA_DIR_MODE, HMAC_KEY_FILE, HMAC_SUBKEY_DIR, ensureDataDir, readOrCreateSecret, writePrivateFile } from './data-dir'

const SUBKEY_NAME = /^([0-9]{6})\.key$/

/** Epoch 0's file key, created on first use: the pre-rotation behaviour. */
export function loadHmacKey(dataDir: string): string {
  return readOrCreateSecret(join(ensureDataDir(dataDir), HMAC_KEY_FILE))
}

export function subKeyDir(dataDir: string): string {
  return join(dataDir, HMAC_SUBKEY_DIR)
}

export function subKeyPath(dataDir: string, epoch: number): string {
  return join(subKeyDir(dataDir), `${epoch}.key`)
}

/** Epochs with a sub-key file, oldest first. */
export function listSubKeyEpochs(dataDir: string): number[] {
  const dir = subKeyDir(dataDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => Number(SUBKEY_NAME.exec(name)?.[1] ?? Number.NaN))
    .filter(isEpoch)
    .sort((a, b) => a - b)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** The sub-key for `epoch`, or null when there is no file. A file that is not a key throws (path only). */
export function readSubKey(dataDir: string, epoch: number): string | null {
  const path = subKeyPath(dataDir, epoch)
  let value: string
  try {
    value = readFileSync(path, 'utf8').trim()
  } catch (error: unknown) {
    if (isMissing(error)) return null
    throw error
  }
  if (!isHexKey(value)) throw new Error(`${path} does not hold a 32-byte hex key`)
  return value
}

/** Temp file, then rename: a reader sees the old file, the new one, or none, never half a key. */
export function writeSubKey(dataDir: string, epoch: number, keyHex: string): void {
  const dir = subKeyDir(dataDir)
  mkdirSync(dir, { recursive: true, mode: DATA_DIR_MODE })
  ensureDataDir(dir)
  const temp = join(dir, `.${epoch}.key.tmp-${process.pid}`)
  try {
    writePrivateFile(temp, `${keyHex}\n`, false)
    renameSync(temp, subKeyPath(dataDir, epoch))
  } catch (error: unknown) {
    rmSync(temp, { force: true })
    throw error
  }
}

export function removeSubKey(dataDir: string, epoch: number): void {
  rmSync(subKeyPath(dataDir, epoch), { force: true })
}

/** The current epoch if it has a file, else the newest before it, else the newest of all (a clock running behind). */
export function pickEpoch(epochs: readonly number[], current: number): number | null {
  if (epochs.includes(current)) return current
  const before = epochs.filter((epoch) => epoch < current)
  return before.at(-1) ?? epochs.at(-1) ?? null
}

/** The sub-key capture should use at `current`, or null when hmac.d holds none. */
export function newestSubKey(dataDir: string, current: number): MarkerKey | null {
  const direct = readSubKey(dataDir, current)
  if (direct !== null) return { hmacKey: direct, epoch: current }
  const epoch = pickEpoch(listSubKeyEpochs(dataDir), current)
  const key = epoch === null ? null : readSubKey(dataDir, epoch)
  return epoch === null || key === null ? null : { hmacKey: key, epoch }
}

export interface LoadMarkerKeyOptions {
  /** False for a daemon whose Keychain master exists but could not be read: it must never start a new hmac.key. */
  mayCreateLegacy?: boolean
}

/** The key to redact with now. The fast path is one read of hmac.d/<current>.key. */
export function loadMarkerKey(dataDir: string, now: number, options: LoadMarkerKeyOptions = {}): MarkerKey {
  const sub = newestSubKey(dataDir, epochAt(now))
  if (sub !== null) return sub
  const legacyPath = join(dataDir, HMAC_KEY_FILE)
  const mayCreate = !existsSync(subKeyDir(dataDir)) && options.mayCreateLegacy !== false
  if (existsSync(legacyPath) || mayCreate) return { hmacKey: loadHmacKey(dataDir), epoch: LEGACY_EPOCH }
  return { hmacKey: randomBytes(32).toString('hex'), epoch: UNKEYED_EPOCH }
}
