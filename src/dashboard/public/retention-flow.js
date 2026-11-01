// The retention save as pure state, like purge-flow.js for purge: Save is
// enabled only after a preview was shown for exactly the values in the form.
// Changing any field (a table's days, the warning size) drops the preview,
// so a save never expires rows the user has not seen counted. The page holds
// the state and renders the Save button from canSave(); saveBody() refuses
// otherwise.

import { formatBytes } from './format.js'

/** @typedef {{ retention: Record<string, number | null>, warnBytes: number }} RetentionBody */
/** @typedef {{ rows: number, bytes: number }} Expiring */
/** @typedef {{ settings: RetentionBody, tables: Record<string, Expiring> }} RetentionPreview */
/** @typedef {{ stage: 'idle' } | { stage: 'previewed', key: string, body: RetentionBody, preview: RetentionPreview }} RetentionFlow */

/** @returns {RetentionFlow} */
export function idleRetention() {
  return { stage: 'idle' }
}

/**
 * Same values, same key, whatever order the form listed them in.
 * @param {RetentionBody} body
 */
export function retentionKey(body) {
  const days = Object.keys(body.retention).sort().map((table) => [table, body.retention[table]])
  return JSON.stringify([days, body.warnBytes])
}

/**
 * @param {RetentionBody} body
 * @returns {RetentionBody & { preview: true }}
 */
export function previewBody(body) {
  return { ...body, preview: true }
}

/**
 * The state after PUT /data/retention with preview: true answered for `body`.
 * @param {RetentionBody} body
 * @param {{ preview?: RetentionPreview }} answer
 * @returns {RetentionFlow}
 */
export function previewedRetention(body, answer) {
  if (answer === null || typeof answer !== 'object' || typeof answer.preview !== 'object' || answer.preview === null) {
    throw new Error('a retention preview needs a preview answer')
  }
  return { stage: 'previewed', key: retentionKey(body), body: { retention: { ...body.retention }, warnBytes: body.warnBytes }, preview: answer.preview }
}

/**
 * @param {RetentionFlow} flow
 * @param {RetentionBody} body the values the form holds now
 */
export function canSave(flow, body) {
  return flow.stage === 'previewed' && flow.key === retentionKey(body)
}

/**
 * The real save; throws unless a preview was shown for these exact values.
 * @param {RetentionFlow} flow
 * @param {RetentionBody} body
 * @returns {RetentionBody}
 */
export function saveBody(flow, body) {
  if (!canSave(flow, body) || flow.stage !== 'previewed') throw new Error('preview these values first')
  return { retention: { ...flow.body.retention }, warnBytes: flow.body.warnBytes }
}

/**
 * "events 12 (40.0 KB), prompts 0 (0 B), …" in table order; "nothing" when every count is zero.
 * @param {RetentionPreview} preview
 * @param {string[]} tables
 */
export function describePreview(preview, tables) {
  const counts = tables.map((table) => ({ table, ...(preview.tables[table] ?? { rows: 0, bytes: 0 }) }))
  if (counts.every((entry) => entry.rows === 0)) return 'nothing'
  return counts.map((entry) => `${entry.table} ${entry.rows} (${formatBytes(entry.bytes)})`).join(', ')
}
