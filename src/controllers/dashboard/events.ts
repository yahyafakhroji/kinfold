// What `kinfold dashboard` prints while it runs: the dashboard's requests
// (method, path, status, time) and the steps a person would want to see
// (a sign-in, a backup, a restore, a settings change). The daemon keeps the
// newest entries in memory and hands them out after a cursor on each
// heartbeat. Entries carry a path without its query string and fixed text,
// never a body, a cookie, a code or memory text.

import { randomBytes } from 'node:crypto'

export type DashboardEvent =
  | { id: number; at: number; kind: 'request'; method: string; path: string; status: number; ms: number }
  | { id: number; at: number; kind: 'event'; text: string }

export interface EventsAfter {
  /** Random per daemon process: a cursor from another process says nothing about this one's ids. */
  epoch: string
  cursor: number
  events: readonly DashboardEvent[]
}

export interface DashboardEvents {
  request(method: string, path: string, status: number, ms: number): void
  note(text: string): void
  /** Entries after `cursor`; a null cursor starts from now. A cursor from another epoch, a restarted daemon's, reads every kept entry. */
  after(cursor: number | null, epoch?: string | null): EventsAfter
}

export const MAX_EVENTS = 200
/** The step noted when a browser signs in; `kinfold dashboard` waits for it before it prints the address as well. */
export const SIGNED_IN_NOTE = 'signed in from a browser'
const EPOCH_BYTES = 9

type EventBody = { kind: 'request'; method: string; path: string; status: number; ms: number } | { kind: 'event'; text: string }

export function createDashboardEvents(now: () => number = Date.now, cap: number = MAX_EVENTS): DashboardEvents {
  const epoch = randomBytes(EPOCH_BYTES).toString('base64url')
  // This closure's own array, appended to and trimmed in place: a daemon request is one or two pushes, and copying the
  // whole log for each made every request allocate `cap` entries. after() hands out a filtered copy, never this array.
  const kept: DashboardEvent[] = []
  let lastId = 0
  const push = (body: EventBody): void => {
    lastId += 1
    kept.push({ id: lastId, at: now(), ...body })
    if (kept.length > cap) kept.splice(0, kept.length - cap)
  }
  return {
    request: (method, path, status, ms) => {
      push({ kind: 'request', method, path, status, ms })
      const notable = notableEvent(method, path, status)
      if (notable !== null) push({ kind: 'event', text: notable })
    },
    note: (text) => push({ kind: 'event', text }),
    after: (cursor, from = null) => {
      if (cursor === null) return { epoch, cursor: lastId, events: [] }
      const after = from === epoch ? cursor : 0
      return { epoch, cursor: lastId, events: kept.filter((event) => event.id > after) }
    },
  }
}

const NOTABLE: ReadonlyArray<readonly [method: string, path: string, text: string]> = [
  ['GET', '/backup', 'backup downloaded'],
  ['POST', '/restore', 'restore started'],
  ['POST', '/restore/undo', 'restore undone'],
  ['PUT', '/observer/settings', 'observer settings changed'],
  ['PUT', '/observer/claude-token', 'claude-cli token saved'],
  ['DELETE', '/observer/claude-token', 'claude-cli token removed'],
  ['PUT', '/embedding/settings', 'embedding settings changed'],
  ['PUT', '/update/settings', 'update settings changed'],
  ['PUT', '/update/auto', 'automatic updates switched'],
  ['POST', '/update/install', 'update install started'],
  ['PUT', '/data/retention', 'retention changed'],
  ['POST', '/data/purge', 'memory purged'],
]

/** A line for a step that succeeded and changed something worth saying; null for any other request. */
export function notableEvent(method: string, path: string, status: number): string | null {
  if (status < 200 || status >= 300) return null
  return NOTABLE.find(([m, p]) => m === method && p === path)?.[2] ?? null
}
