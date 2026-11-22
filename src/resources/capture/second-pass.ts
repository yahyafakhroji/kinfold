// The second run of the edge's redaction over an event already captured: what
// the daemon does at ingest, and what the leak scanner does to see whether a
// stored row would still pass today's rules. Beside the first pass (prepare.ts)
// and below the daemon, so the scanner does not load the ingest path to get it.

import { type RedactedEvent, DEFAULT_MAX_FIELD_CHARS, type PrepareOptions, prepareForSpool } from './prepare'
import type { NormalizedEvent } from '../../system/contract/event'

/** The edge already capped fields; the slack lets a capped field plus its truncation marker through untouched. */
const SECOND_PASS_SLACK = 256
const WITHHELD_MARKER = /^<withheld reason="[a-z_]+" lines="\d+" chars="\d+"\/>$/

/**
 * The daemon's redaction pass, in case the rules changed since
 * capture. Redaction markers survive a re-run unchanged; the withheld marker
 * would not (it would describe itself), so an intact one is kept, and the
 * edge's redaction notes are kept alongside any new ones.
 */
export function secondPass(event: NormalizedEvent, options: PrepareOptions): RedactedEvent {
  const maxFieldChars = (options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS) + SECOND_PASS_SLACK
  const again = prepareForSpool(event, { ...options, maxFieldChars })
  const original = event.tool
  const keepMarker = original?.withheld !== undefined && WITHHELD_MARKER.test(original.output)
  const freshNotes = (again.redactions ?? []).filter(
    (note) => !(keepMarker && note.field === 'tool.output' && note.rule === original?.withheld),
  )
  return {
    ...again,
    ...(keepMarker && again.tool !== undefined ? { tool: { ...again.tool, output: original!.output } } : {}),
    redactions: [...(event.redactions ?? []), ...freshNotes],
  } as RedactedEvent
}
