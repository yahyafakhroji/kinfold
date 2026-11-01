// The daemon's HMAC keys (P1-J). At start it reads the Keychain master once
// and holds it for its lifetime. From it, the daemon derives the current
// epoch's marker sub-key, writes it to hmac.d/<epoch>.key before capture
// needs it, and rotates monthly. It keeps the previous epoch's file for
// in-flight spool and plugin processes, writes the next one in the last two
// days of a month (so a capture whose clock runs ahead still finds a file),
// and deletes the rest. Three modes:
//   master:   the Keychain gave the master; every epoch can be rebuilt.
//   legacy:   no master (install not re-run): hmac.key, epoch 0, as before P1-J.
//   degraded: a master may exist but could not be read (locked, denied): serve
//             on the newest sub-key file, never mint a master, never create
//             hmac.key, pause credential fingerprints, retry on each rotation tick.
// Logs carry the mode, epochs and an error class; never key bytes.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MarkerKey } from '../redaction/redact'
import type { CredentialProvider } from '../secrets/credentials'
import { type FingerprintKey, LEGACY_FINGERPRINT_SCHEME, MASTER_FINGERPRINT_SCHEME } from '../secrets/fingerprint'
import { HMAC_LEGACY_REF, LEGACY_EPOCH, epochAt, epochStart, fingerprintKey, isEpoch, isHexKey, markerSubKey, nextEpoch, previousEpoch, readMaster } from '../secrets/hmac-keys'
import { HMAC_KEY_FILE } from '../store/data-dir'
import { listSubKeyEpochs, loadMarkerKey, readSubKey, removeSubKey, writeSubKey } from '../store/hmac-key'

export const ROTATION_TICK_MS = 60 * 60_000
/** The next epoch's file appears this long before the month turns. */
export const WRITE_AHEAD_MS = 2 * 24 * 60 * 60_000

export type HmacMode = 'master' | 'legacy' | 'degraded'

export interface HmacKeyState {
  mode: () => HmacMode
  /** What the drain's second pass, the scanner and resolve redact with now. */
  marker: () => MarkerKey
  /** Null while unknown: credential-fingerprint resets pause. */
  fingerprint: () => FingerprintKey | null
  /** The key of any epoch this daemon can rebuild, or null. */
  keyFor: (epoch: number) => string | null
  /** Rotation in master mode; a fresh Keychain attempt in degraded mode. */
  tick: () => void
}

export interface HmacKeyOptions {
  dataDir: string
  keychain: CredentialProvider
  now: () => number
  log: (line: string) => void
}

export interface RotationResult {
  current: number
  written: number[]
  deleted: number[]
}

function safeReadSubKey(dataDir: string, epoch: number): string | null {
  try {
    return readSubKey(dataDir, epoch)
  } catch {
    // Not a key: the caller rewrites or ignores it.
    return null
  }
}

/** The epochs that need a sub-key at `now`: this month, and next month too in its last WRITE_AHEAD_MS. */
export function wantedEpochs(now: number): number[] {
  const current = epochAt(now)
  const next = nextEpoch(current)
  return now >= epochStart(next) - WRITE_AHEAD_MS ? [current, next] : [current]
}

/** Writes the epochs capture may need, keeps the previous one, deletes the rest. Idempotent. */
export function rotateSubKeys(dataDir: string, master: string, now: number): RotationResult {
  const current = epochAt(now)
  const wanted = wantedEpochs(now)
  const written = wanted.filter((epoch) => {
    const key = markerSubKey(master, epoch)
    if (safeReadSubKey(dataDir, epoch) === key) return false
    writeSubKey(dataDir, epoch, key)
    return true
  })
  const keep = new Set([previousEpoch(current), ...wanted])
  const deleted = listSubKeyEpochs(dataDir).filter((epoch) => !keep.has(epoch))
  for (const epoch of deleted) removeSubKey(dataDir, epoch)
  return { current, written, deleted }
}

export function describeRotation(result: RotationResult): string | null {
  if (result.written.length === 0 && result.deleted.length === 0) return null
  return `hmac rotation epoch=${result.current} wrote=${result.written.join(',') || 'none'} deleted=${result.deleted.join(',') || 'none'}`
}

function legacyFileKey(dataDir: string): string | null {
  const path = join(dataDir, HMAC_KEY_FILE)
  if (!existsSync(path)) return null
  const value = readFileSync(path, 'utf8').trim()
  return isHexKey(value) ? value : null
}

/** Epoch 0 from its Keychain copy, read once on first need; null when absent or unreadable. */
function legacyFromKeychain(keychain: CredentialProvider): () => string | null {
  let cached: string | null | undefined
  return () => {
    if (cached !== undefined) return cached
    try {
      const value = keychain.get(HMAC_LEGACY_REF)
      cached = value !== null && isHexKey(value) ? value : null
    } catch {
      return null
    }
    return cached
  }
}

function markerFromMaster(master: string, now: number): MarkerKey {
  const epoch = epochAt(now)
  return { hmacKey: markerSubKey(master, epoch), epoch }
}

export function createHmacKeys(options: HmacKeyOptions): HmacKeyState {
  const { dataDir, keychain, now, log } = options
  let master: string | null = null
  let mode: HmacMode = 'legacy'
  const legacy = legacyFromKeychain(keychain)

  const rotate = (): void => {
    if (master === null) return
    try {
      const line = describeRotation(rotateSubKeys(dataDir, master, now()))
      if (line !== null) log(line)
    } catch (error: unknown) {
      log(`hmac rotation failed: ${error instanceof Error ? error.name : 'unknown error'}`)
    }
  }
  const tryMaster = (): void => {
    const read = readMaster(keychain)
    if (read.state === 'present') {
      master = read.master
      mode = 'master'
      log(`hmac keys mode=master epoch=${epochAt(now())}`)
      rotate()
    } else if (read.state === 'unavailable') {
      if (mode !== 'degraded') log(`hmac keychain unavailable class=${read.errorClass}; serving on existing key files`)
      mode = 'degraded'
    } else {
      log(`hmac keys mode=legacy${listSubKeyEpochs(dataDir).length > 0 ? ' with sub-key files but no master' : ''}`)
    }
  }
  tryMaster()

  return {
    mode: () => mode,
    marker: () => (master !== null ? markerFromMaster(master, now()) : loadMarkerKey(dataDir, now(), { mayCreateLegacy: mode === 'legacy' })),
    fingerprint: () => {
      if (master !== null) return { key: fingerprintKey(master), scheme: MASTER_FINGERPRINT_SCHEME }
      const file = mode === 'legacy' ? legacyFileKey(dataDir) : null
      return file !== null ? { key: file, scheme: LEGACY_FINGERPRINT_SCHEME } : null
    },
    keyFor: (epoch) => {
      if (epoch === LEGACY_EPOCH) return legacyFileKey(dataDir) ?? (master !== null ? legacy() : null)
      if (!isEpoch(epoch)) return null
      if (master !== null) return markerSubKey(master, epoch)
      return safeReadSubKey(dataDir, epoch)
    },
    tick: () => (mode === 'degraded' ? tryMaster() : rotate()),
  }
}
