// The id lists the store keeps as JSON text (injections.observation_ids,
// mcp_reads.observation_ids, pack rows).

/** The safe-integer ids of a stored JSON array. A row this build did not write reads as no ids, so a read is served without them and does not fail. */
export function parseIds(json: string): number[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id)) : []
  } catch {
    return []
  }
}
