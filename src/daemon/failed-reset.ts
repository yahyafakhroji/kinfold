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

import { clearBackoff, providerBackoffs } from '../observer/backoff'
import { credentialRefFor, resolveObserverSettings, settingsFingerprint } from '../observer/settings'
import type { ObserverSettings } from '../observer/types'
import { type CredentialProvider, isSystemCredentialRef } from '../secrets/credentials'
import { type FingerprintKey, NO_CREDENTIAL_NEEDED, credentialFingerprint, fingerprintScheme } from '../secrets/fingerprint'
import type { Database } from '../sqlite/types'
import { type HostFingerprints, hostsWithFailedEvents, readFingerprints, resetExhaustedForHost, writeFingerprints } from '../store/observer-reset'

export const DEFAULT_RESET_CHECK_MS = 30_000
/** How long a credential's fingerprint is trusted before the key store is asked again. On macOS each ask spawns `security`, on the thread that answers hooks. */
export const CREDENTIAL_RECHECK_MS = 120_000
/** How far back a backing-off provider's runs are read for their hosts: observer_runs is never pruned, and the runs that made the backoff are recent. */
export const BACKOFF_HOSTS_WINDOW_MS = 7 * 24 * 3_600_000

/** What one daemon remembers between checks, so a check every 30 s does not repeat its key-store reads and its log lines. */
export interface ResetMemo {
  /** Per key scheme and ref: the fingerprint last read and when. Never the credential. */
  credentials: Map<string, { fingerprint: string; readAt: number }>
  /** Per host: the reason its check was last skipped, so the reason is logged when it changes and not on every tick. */
  skipped: Map<string, string>
}

export function createResetMemo(): ResetMemo {
  return { credentials: new Map(), skipped: new Map() }
}
const INVALID_SETTINGS = 'invalid'

export interface FailedResetDeps {
  db: Database
  credentials: CredentialProvider
  /** Null while the key is unavailable: credential checks pause. */
  fingerprintKey: FingerprintKey | null
  now?: () => number
  /** Left out, every check reads the key store and logs every skip, as a one-off check should. */
  memo?: ResetMemo
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
    return { ok: true, fingerprints: { settings: settingsFingerprint(settings), credential: credentialOf(deps, key, ref) } }
  } catch {
    return { ok: false, skipped: 'credential lookup failed' }
  }
}

/** The credential's fingerprint, from the memo while it is fresh. A lookup that throws is not remembered. */
function credentialOf(deps: FailedResetDeps, key: FingerprintKey, ref: string): string {
  const now = (deps.now ?? Date.now)()
  const memoKey = `${key.scheme}\n${ref}`
  const known = deps.memo?.credentials.get(memoKey)
  if (known !== undefined && now >= known.readAt && now - known.readAt < CREDENTIAL_RECHECK_MS) return known.fingerprint
  const fingerprint = credentialFingerprint(key.key, ref, deps.credentials.get(ref), key.scheme)
  deps.memo?.credentials.set(memoKey, { fingerprint, readAt: now })
  return fingerprint
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
    if (deps.memo?.skipped.get(host) !== read.skipped) deps.log?.(`observer reset check host=${host} skipped: ${read.skipped}`)
    deps.memo?.skipped.set(host, read.skipped)
    return null
  }
  deps.memo?.skipped.delete(host)
  const after = read.fingerprints
  const before = readFingerprints(deps.db, host)
  const reason = before === null ? null : reasonFor(before, after)
  if (before !== null && reason === null && before.credential === after.credential && before.settings === after.settings) return null
  return deps.db.transaction(() => {
    writeFingerprints(deps.db, host, after, now)
    if (reason === null) return null
    if (reason !== 'settings') clearHostBackoff(deps.db, host, now)
    return { host, reason, events: resetExhaustedForHost(deps.db, host) }
  })()
}

/** A new credential may be the fix the backoff line asked for; settings changes are already read by the backoff itself. */
function clearHostBackoff(db: Database, host: string, now: number): void {
  try {
    clearBackoff(db, resolveObserverSettings(db, host).provider, now)
  } catch {
    // Settings that cannot be resolved name no provider to clear.
  }
}

/** Hosts with failed events, and hosts whose recent runs used a provider that is backing off (its events wait as pending). */
function hostsToCheck(db: Database, now: number): string[] {
  // By time first (observer_runs_by_time), so the read is the last week's runs and not every run ever recorded.
  const waiting = providerBackoffs(db).flatMap((entry) =>
    db.query<{ host: string }, { provider: string; since: number }>('SELECT DISTINCT host FROM observer_runs WHERE started_at > $since AND provider = $provider')
      .all({ provider: entry.provider, since: now - BACKOFF_HOSTS_WINDOW_MS }).map((row) => row.host))
  return [...new Set([...hostsWithFailedEvents(db), ...waiting])].sort()
}

/** One pass over hosts with failed events. Returns the hosts whose settings or credential changed. */
export function checkFailedResets(deps: FailedResetDeps): ResetOutcome[] {
  const now = (deps.now ?? Date.now)()
  const outcomes = hostsToCheck(deps.db, now)
    .map((host) => checkHost(deps, host, now))
    .filter((outcome): outcome is ResetOutcome => outcome !== null)
  for (const outcome of outcomes) deps.log?.(`observer reset host=${outcome.host} reason=${outcome.reason} events=${outcome.events}`)
  return outcomes
}
