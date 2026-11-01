// Sends failed observer events back to pending (user decision, task 8). An
// event that failed MAX_OBSERVER_ATTEMPTS times stays failed until something
// that could fix it changes: the host's observer settings, or the credential
// its provider reads (compared by fingerprint), or an explicit retry request.
// observer_fingerprints keeps the last seen pair per host.

import type { Database } from '../sqlite/types'
import { MAX_OBSERVER_ATTEMPTS } from './observer-store'

export interface HostFingerprints {
  settings: string
  credential: string
}

export type RetryTarget = { sessionId: number } | { all: true }

/** Hosts that have failed events (any attempt count), so a baseline exists before they are exhausted. */
export function hostsWithFailedEvents(db: Database): string[] {
  return db.query<{ host: string }, []>(
    `SELECT DISTINCT s.host FROM events e JOIN sessions s ON s.id = e.session_id
     WHERE e.observer_state = 'failed' ORDER BY s.host`,
  ).all().map((row) => row.host)
}

export function readFingerprints(db: Database, host: string): HostFingerprints | null {
  return db.query<HostFingerprints, { host: string }>('SELECT settings, credential FROM observer_fingerprints WHERE host = $host').get({ host })
}

export function writeFingerprints(db: Database, host: string, fingerprints: HostFingerprints, now: number): void {
  db.query(
    `INSERT INTO observer_fingerprints (host, settings, credential, checked_at) VALUES ($host, $settings, $credential, $now)
     ON CONFLICT (host) DO UPDATE SET settings = excluded.settings, credential = excluded.credential, checked_at = excluded.checked_at`,
  ).run({ host, ...fingerprints, now })
}

const TO_PENDING = "observer_state = 'pending', observer_attempts = 0, observer_retry_at = NULL"

/** Exhausted failed events of one host's sessions back to pending, attempts reset. Returns the count. */
export function resetExhaustedForHost(db: Database, host: string): number {
  return db.query(
    `UPDATE events SET ${TO_PENDING}
     WHERE observer_state = 'failed' AND observer_attempts >= $maxAttempts
       AND session_id IN (SELECT id FROM sessions WHERE host = $host)`,
  ).run({ host, maxAttempts: MAX_OBSERVER_ATTEMPTS }).changes
}

/** POST /observer/retry: every failed event of one session, or of all sessions, back to pending. */
export function resetFailedEvents(db: Database, target: RetryTarget): number {
  if ('sessionId' in target) {
    return db.query(`UPDATE events SET ${TO_PENDING} WHERE observer_state = 'failed' AND session_id = $sessionId`)
      .run({ sessionId: target.sessionId }).changes
  }
  return db.run(`UPDATE events SET ${TO_PENDING} WHERE observer_state = 'failed'`).changes
}
