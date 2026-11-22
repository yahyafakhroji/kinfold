// POST /central/capture on the hub: a batch of events a device captured and
// redacted, each with the project key the device resolved. Each event is
// checked on its own: one the hub cannot take is named back by id, so the
// device sets it aside instead of resending the whole batch forever, and the
// rest is stored in one transaction. A retry after a lost answer is a no-op
// (event ids are unique).

import type { PrepareOptions } from '../../resources/capture/prepare'
import { validateEvent } from '../../system/contract/event'
import { type ResolvedEvent, ingestResolved } from '../daemon/ingest'
import type { Database } from '../../resources/sqlite/types'
import type { HubAnswer, HubContext } from './hub-server'
import { parseDeviceProject } from './project-key'
import { canonicalKey } from '../../resources/store/project-merge'

/** Far above what one relay batch sends; the byte cap is the real bound. */
export const MAX_CAPTURE_EVENTS = 1_000

export interface CaptureDeps {
  db: Database
  /** The hub's redaction keys: every event is redacted again here. */
  prepare: PrepareOptions | (() => PrepareOptions)
  now: () => number
  /** New rows were stored: the observer has work. */
  onStored: () => void
}

/**
 * Whether a device may add to the session (host, hostSessionId). A new
 * session is its own; an existing one only when it sits under a shared git
 * remote, under a key scoped to this device, or under the very key the
 * device resolved. A session in another device's folder, or in one of the
 * hub's own folders, is not the device's to write into, whatever ids it knows.
 */
export function sessionWritable(db: Database, host: string, hostSessionId: string, projectKey: string, deviceId: string): boolean {
  const row = db.query(`SELECT s.project_key AS key, p.key_kind AS kind FROM sessions s JOIN projects p ON p.key = s.project_key
    WHERE s.host = $host AND s.host_session_id = $hostSessionId`).get({ host, hostSessionId }) as { key: string; kind: string } | null
  // A key merged into another (store/project-merge.ts) names the project the session moved to.
  return row === null || row.key === projectKey || row.key === canonicalKey(db, projectKey) || row.kind === 'git-remote' || row.key.startsWith(`${deviceId}:`)
}

const eventIdOf = (value: unknown): string | null => {
  const id = typeof value === 'object' && value !== null ? (value as { eventId?: unknown }).eventId : undefined
  return typeof id === 'string' && id.length <= 64 ? id : null
}

function parseBatch(db: Database, body: unknown, deviceId: string): { items: ResolvedEvent[]; rejected: string[] } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const events = (body as { events?: unknown }).events
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_CAPTURE_EVENTS) return null
  const items: ResolvedEvent[] = []
  const rejected: string[] = []
  for (const item of events) {
    if (typeof item !== 'object' || item === null) return null
    const { event, project } = item as Record<string, unknown>
    const checked = validateEvent(event)
    const scoped = parseDeviceProject(project, deviceId)
    if (checked.ok && scoped !== null && sessionWritable(db, checked.event.host, checked.event.hostSessionId, scoped.key, deviceId)) {
      items.push({ event: checked.event, project: scoped })
      continue
    }
    const id = eventIdOf(event)
    // An item with no usable id cannot be named back, so the device could never set it aside.
    if (id === null) return null
    rejected.push(id)
  }
  return { items, rejected }
}

export function captureHandler(deps: CaptureDeps): (body: unknown, context: HubContext) => HubAnswer {
  return (body, context) => {
    const batch = parseBatch(deps.db, body, context.deviceId)
    if (batch === null) return { status: 400, body: { error: 'body must be {"events": [{"event": ..., "project": ...}]}, each event with an id' } }
    const prepare = typeof deps.prepare === 'function' ? deps.prepare() : deps.prepare
    const result = batch.items.length === 0 ? { inserted: 0, duplicates: 0 } : ingestResolved(deps.db, batch.items, { ...prepare, now: deps.now, device: context.deviceId })
    if (result.inserted > 0) deps.onStored()
    return { status: 200, body: { stored: result.inserted, duplicates: result.duplicates, rejected: batch.rejected } }
  }
}
