// Evidence strength for observations (architecture decision D2).
// The observer proposes a strength and cites source event ids; the daemon
// calls resolveEvidenceStrength before storing, so the label stored is the
// daemon's verdict, not the model's claim.

export type EvidenceStrength = 'tool-verified' | 'interpretation' | 'user-stated'

export interface SourceEvent {
  eventId: string
  kind: 'user_prompt' | 'tool_result' | 'turn_end'
  /** outputChars counts what the observer saw; a withheld output backs no claim. */
  tool?: { name: string; exitCode?: number; outputChars: number; withheld?: boolean }
}

export interface ProposedEvidence {
  strength: EvidenceStrength // what the observer model claimed
  sourceEventIds: string[]   // events the observer says back the claim
}

/**
 * Decide the strength the daemon stores for one observation.
 *
 * @param proposed what the observer model returned
 * @param cited    the cited events that actually exist in this session
 *                 (unknown ids are already filtered out by the caller)
 */
export function resolveEvidenceStrength(
  proposed: ProposedEvidence,
  cited: readonly SourceEvent[],
): EvidenceStrength {
  if (proposed.strength === 'tool-verified') {
    // A failed command backs a claim about the failure. A clean exit with no
    // output backs nothing: that is how a broken filter becomes a "fact".
    const backed = cited.some((event) =>
      event.kind === 'tool_result'
      && event.tool?.withheld !== true
      && ((event.tool?.outputChars ?? 0) > 0 || (event.tool?.exitCode ?? 0) !== 0))
    return backed ? 'tool-verified' : 'interpretation'
  }
  if (proposed.strength === 'user-stated') {
    return cited.some((event) => event.kind === 'user_prompt') ? 'user-stated' : 'interpretation'
  }
  return 'interpretation'
}
