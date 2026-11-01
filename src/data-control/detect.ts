// Runs the current redaction rules over one stored row, in memory. An event
// payload goes through the daemon's own second pass (the same code ingest
// uses), so a scan finds exactly what a fresh ingest would redact, and an
// intact withheld marker is not mistaken for a new hit. Text columns go
// through redactText. The result carries the rewritten values (for a
// "redact" resolution) and the notes; callers keep the notes' rule, field
// and count only. The matched text never leaves this function's caller.

import type { NormalizedEvent, RedactionNote } from '../contract/event'
import { isRecord } from '../contract/event'
import { secondPass } from '../daemon/ingest'
import { type RedactOptions, redactText } from '../redaction/redact'
import type { ScanRow } from '../store/scan-store'

/** Notes that are not a redaction: an entropy hint left in place, and the size cap. */
const NOT_A_LEAK: ReadonlySet<string> = new Set(['high_entropy_flagged', 'oversize'])

export interface RowRedaction {
  values: Record<string, string | null>
  /** Leaks only: what the current rules would redact that the stored text still holds. */
  notes: RedactionNote[]
  /** Events: the redaction notes the rewritten payload carries (old plus new). */
  eventNotes: RedactionNote[] | null
}

function leaksOnly(notes: readonly RedactionNote[]): RedactionNote[] {
  return notes.filter((note) => !NOT_A_LEAK.has(note.rule))
}

function redactPayload(payload: string, options: RedactOptions): RowRedaction {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    // Not JSON (a row this build did not write): check it as plain text.
    parsed = null
  }
  if (!isRecord(parsed)) {
    const result = redactText(payload, 'payload', options)
    return { values: { payload: result.value }, notes: leaksOnly(result.notes), eventNotes: result.notes }
  }
  const event = parsed as unknown as NormalizedEvent
  const before = Array.isArray(event.redactions) ? event.redactions.length : 0
  const again = secondPass(event, options)
  const notes = [...(again.redactions ?? [])]
  return { values: { payload: JSON.stringify(again) }, notes: leaksOnly(notes.slice(before)), eventNotes: notes }
}

export function redactRow(row: ScanRow, options: RedactOptions): RowRedaction {
  if (row.table === 'events') {
    const payload = row.fields.payload ?? null
    return payload === null ? { values: {}, notes: [], eventNotes: null } : redactPayload(payload, options)
  }
  const values: Record<string, string | null> = {}
  const notes: RedactionNote[] = []
  for (const [column, text] of Object.entries(row.fields)) {
    if (text === null) {
      values[column] = null
      continue
    }
    const result = redactText(text, column, options)
    values[column] = result.value
    notes.push(...leaksOnly(result.notes))
  }
  return { values, notes, eventNotes: null }
}

export interface FindingSpot {
  field: string
  rule: string
  matches: number
}

/** One spot per (field, rule), counts summed. */
export function findingsOf(notes: readonly RedactionNote[]): FindingSpot[] {
  const spots = new Map<string, FindingSpot>()
  for (const note of notes) {
    const key = `${note.field}\0${note.rule}`
    const seen = spots.get(key)
    spots.set(key, { field: note.field, rule: note.rule, matches: (seen?.matches ?? 0) + note.count })
  }
  return [...spots.values()]
}
