// Turns stored events into the SourceEvent shape resolveEvidenceStrength reads
// (src/evidence.ts decides; this file only describes what the observer saw).
// outputChars is the stored, redacted output length, and a withheld output
// counts as withheld whatever its marker text says.

import { isRecord } from '../contract/event'
import { type EvidenceStrength, type SourceEvent, resolveEvidenceStrength } from '../evidence'
import type { ObserverEvent, ParsedObservation } from './types'

const CITABLE_KINDS: ReadonlySet<string> = new Set(['user_prompt', 'tool_result', 'turn_end'])

function storedTool(payload: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload)
    return isRecord(value) && isRecord(value.tool) ? value.tool : null
  } catch {
    return null
  }
}

/** session_start and session_end back no claim, so they map to null and never raise a strength. */
export function toSourceEvent(event: ObserverEvent): SourceEvent | null {
  if (!CITABLE_KINDS.has(event.kind)) return null
  const kind = event.kind as SourceEvent['kind']
  if (kind !== 'tool_result') return { eventId: event.eventId, kind }
  const tool = storedTool(event.payload)
  const output = typeof tool?.output === 'string' ? tool.output : ''
  const storedExit = typeof tool?.exitCode === 'number' && Number.isInteger(tool.exitCode) ? tool.exitCode : undefined
  // A host-reported failure with no exit code (a failed Read, an interrupted Bash) is still a failed exit.
  const exitCode = storedExit ?? (tool?.isError === true ? 1 : undefined)
  return {
    eventId: event.eventId,
    kind,
    tool: {
      name: event.toolName ?? (typeof tool?.name === 'string' ? tool.name : 'unknown'),
      outputChars: output.length,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(event.withheld !== null || typeof tool?.withheld === 'string' ? { withheld: true } : {}),
    },
  }
}

/** The strength the daemon stores: the model's proposal, checked against the events it cited. */
export function finalStrength(observation: ParsedObservation, batch: readonly ObserverEvent[]): EvidenceStrength {
  const cited = new Set(observation.evidence.sourceEventIds)
  const sources = batch
    .filter((event) => cited.has(event.eventId))
    .map(toSourceEvent)
    .filter((source): source is SourceEvent => source !== null)
  return resolveEvidenceStrength(observation.evidence, sources)
}
