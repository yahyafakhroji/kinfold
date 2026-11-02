// Gives stuck observer events another chance when their cause may be fixed:
// for every host with failed events, compare its
// resolved observer settings and its provider's credential fingerprint with
// the last ones seen. The first sight records a baseline; a later difference
// resets that host's exhausted events to pending. The credential is read only
// to fingerprint it (HMAC under the data dir key) and is never stored or
// logged. Logs carry host, reason and counts only. The fingerprint key
// comes from the daemon's key state. While it is unknown (Keychain locked at
// start), hosts that need a credential are skipped, so nothing resets by
// mistake; and a stored fingerprint under the other key scheme (hmac.key
// before the migration, the master after) is re-baselined, not a change.

import { credentialRefFor, resolveObserverSettings, settingsFingerprint } from '../observer/settings'
import type { ObserverSettings } from '../observer/types'
import { type CredentialProvider, isSystemCredentialRef } from '../secrets/credentials'
import { type FingerprintKey, NO_CREDENTIAL_NEEDED, credentialFingerprint, fingerprintScheme } from '../secrets/fingerprint'
import type { Database } from '../sqlite/types'
import { type HostFingerprints, hostsWithFailedEvents, readFingerprints, resetExhaustedForHost, writeFingerprints } from '../store/observer-reset'

export const DEFAULT_RESET_CHECK_MS = 30_000
const INVALID_SETTINGS = 'invalid'

export interface FailedResetDeps {
  db: Database
  credentials: CredentialProvider
  /** Null while the key is unavailable: credential checks pause. */
  fingerprintKey: FingerprintKey | null
  now?: () => number
  log?: (line: string) => void
}

export type ResetReason = 'settings' | 'credential' | 'settings+credential'

export interface ResetOutcome {
  host: string
  reason: ResetReason
  events: number
}

export type FingerprintRead = { ok: true; fingerprints: HostFingerprints } | { ok: false; skipped: 'credential lookup failed' | 'hmac key unavailable' | 'credential ref names a system key' }

/** Not ok when the credential or the key is unknown: an unknown is not a change, so the host waits for the next check. */
export function currentFingerprints(deps: FailedResetDeps, host: string): FingerprintRead {
  let settings: ObserverSettings
  try {
    settings = resolveObserverSettings(deps.db, host)
  } catch {
    // config_invalid: fingerprint it as such, so fixing the row reads as a change.
    return { ok: true, fingerprints: { settings: INVALID_SETTINGS, credential: NO_CREDENTIAL_NEEDED } }
  }
  const ref = credentialRefFor(settings)
  if (ref === null) return { ok: true, fingerprints: { settings: settingsFingerprint(settings), credential: NO_CREDENTIAL_NEEDED } }
  if (isSystemCredentialRef(ref)) return { ok: false, skipped: 'credential ref names a system key' }
  const key = deps.fingerprintKey
  if (key === null) return { ok: false, skipped: 'hmac key unavailable' }
  try {
    const credential = credentialFingerprint(key.key, ref, deps.credentials.get(ref), key.scheme)
    return { ok: true, fingerprints: { settings: settingsFingerprint(settings), credential } }
  } catch {
    return { ok: false, skipped: 'credential lookup failed' }
  }
}

/** Two keyed fingerprints under different key schemes compare nothing: the key moved, not the credential. */
function credentialChanged(before: string, after: string): boolean {
  const schemes = [fingerprintScheme(before), fingerprintScheme(after)]
  if (schemes[0] !== null && schemes[1] !== null && schemes[0] !== schemes[1]) return false
  return before !== after
}

function reasonFor(before: HostFingerprints, after: HostFingerprints): ResetReason | null {
  const settings = before.settings !== after.settings
  const credential = credentialChanged(before.credential, after.credential)
  if (settings && credential) return 'settings+credential'
  if (settings) return 'settings'
  return credential ? 'credential' : null
}

function checkHost(deps: FailedResetDeps, host: string, now: number): ResetOutcome | null {
  const read = currentFingerprints(deps, host)
  if (!read.ok) {
    deps.log?.(`observer reset check host=${host} skipped: ${read.skipped}`)
    return null
  }
  const after = read.fingerprints
  const before = readFingerprints(deps.db, host)
  const reason = before === null ? null : reasonFor(before, after)
  if (before !== null && reason === null && before.credential === after.credential && before.settings === after.settings) return null
  return deps.db.transaction(() => {
    writeFingerprints(deps.db, host, after, now)
    if (reason === null) return null
    return { host, reason, events: resetExhaustedForHost(deps.db, host) }
  })()
}

/** One pass over hosts with failed events. Returns the hosts whose settings or credential changed. */
export function checkFailedResets(deps: FailedResetDeps): ResetOutcome[] {
  const now = (deps.now ?? Date.now)()
  const outcomes = hostsWithFailedEvents(deps.db)
    .map((host) => checkHost(deps, host, now))
    .filter((outcome): outcome is ResetOutcome => outcome !== null)
  for (const outcome of outcomes) deps.log?.(`observer reset host=${outcome.host} reason=${outcome.reason} events=${outcome.events}`)
  return outcomes
}
