// The purge flow as pure state: a purge can only be confirmed for exactly
// the target a dry run was shown for. Editing the target after the dry run
// (another session id, a wider range) drops the preview, so the confirm
// button never sends counts the user has not seen. Pages hold the state and
// render the button from canConfirm(); confirmBody() refuses otherwise.

/** @typedef {Record<string, string | number>} PurgeTarget */
/** @typedef {{ stage: 'idle' } | { stage: 'previewed', key: string, target: PurgeTarget, counts: Record<string, number> }} PurgeFlow */

/** @returns {PurgeFlow} */
export function idleFlow() {
  return { stage: 'idle' }
}

/**
 * A stable identity for a target: same keys and values, any order.
 * @param {PurgeTarget} target
 */
export function targetKey(target) {
  return JSON.stringify(Object.keys(target).sort().map((key) => [key, target[key]]))
}

/**
 * @param {PurgeTarget} target
 * @returns {PurgeTarget & { dryRun: true }}
 */
export function dryRunBody(target) {
  return { ...target, dryRun: true }
}

/**
 * The state after a dry run answered for `target`.
 * @param {PurgeTarget} target
 * @param {{ dryRun: boolean, counts: Record<string, number> }} report
 * @returns {PurgeFlow}
 */
export function previewed(target, report) {
  if (report.dryRun !== true) throw new Error('a preview needs a dry-run report')
  return { stage: 'previewed', key: targetKey(target), target: { ...target }, counts: { ...report.counts } }
}

/**
 * @param {PurgeFlow} flow
 * @param {PurgeTarget} target the target the form names now
 */
export function canConfirm(flow, target) {
  return flow.stage === 'previewed' && flow.key === targetKey(target)
}

/**
 * The real purge request; throws unless a dry run was shown for this exact target.
 * @param {PurgeFlow} flow
 * @param {PurgeTarget} target
 * @returns {PurgeTarget & { dryRun: false }}
 */
export function confirmBody(flow, target) {
  if (!canConfirm(flow, target) || flow.stage !== 'previewed') throw new Error('run a dry run for this target first')
  return { ...flow.target, dryRun: false }
}

/**
 * Non-zero counts as "events 12, observations 3"; "nothing" when all are zero.
 * @param {Record<string, number>} counts
 */
export function describeCounts(counts) {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([table, n]) => `${table} ${n}`)
  return parts.length === 0 ? 'nothing' : parts.join(', ')
}
