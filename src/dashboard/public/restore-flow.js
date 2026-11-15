// The restore as pure state, like purge-flow.js for purge: Restore is enabled
// only once a backup was uploaded and its manifest shown, the person ticked
// the confirmation, and (for an encrypted backup) typed a recovery code. The
// code is never part of the state: it goes from the input straight into the
// one request body restoreBody() builds.

import { formatBytes, formatTime } from './format.js'

/** @typedef {{ createdAt: number, kinfoldVersion: string, schemaVersion: number, encrypted: boolean, bytes: number }} ManifestView */
/** @typedef {{ stage: 'idle' } | { stage: 'uploaded', upload: string, manifest: ManifestView }} RestoreFlow */

/** @returns {RestoreFlow} */
export function idleRestore() {
  return { stage: 'idle' }
}

/**
 * The state after POST /restore/upload answered.
 * @param {unknown} answer
 * @returns {RestoreFlow}
 */
export function uploadedRestore(answer) {
  const bad = new Error('the daemon did not describe the backup')
  if (answer === null || typeof answer !== 'object' || typeof answer.upload !== 'string') throw bad
  const manifest = answer.manifest
  if (manifest === null || typeof manifest !== 'object') throw bad
  const { createdAt, kinfoldVersion, schemaVersion, encrypted, bytes } = manifest
  if (typeof createdAt !== 'number' || typeof kinfoldVersion !== 'string' || typeof schemaVersion !== 'number' || typeof encrypted !== 'boolean' || typeof bytes !== 'number') throw bad
  return { stage: 'uploaded', upload: answer.upload, manifest: { createdAt, kinfoldVersion, schemaVersion, encrypted, bytes } }
}

/**
 * @param {RestoreFlow} flow
 * @param {string} code what the code field holds now
 * @param {boolean} confirmed
 */
export function canRestore(flow, code, confirmed) {
  return flow.stage === 'uploaded' && confirmed && (!flow.manifest.encrypted || code.trim() !== '')
}

/**
 * The POST /restore body; throws unless canRestore. The code is sent only for
 * an encrypted backup.
 * @param {RestoreFlow} flow
 * @param {string} code
 * @param {boolean} confirmed
 * @returns {{ upload: string, code?: string }}
 */
export function restoreBody(flow, code, confirmed) {
  if (!canRestore(flow, code, confirmed) || flow.stage !== 'uploaded') throw new Error('choose a backup, type its recovery code and confirm first')
  return flow.manifest.encrypted ? { upload: flow.upload, code: code.trim() } : { upload: flow.upload }
}

/**
 * Label and value pairs for the page's facts list.
 * @param {ManifestView} manifest
 * @returns {[string, string][]}
 */
export function describeManifest(manifest) {
  return [
    ['Made', formatTime(manifest.createdAt)],
    ['Kinfold', manifest.kinfoldVersion],
    ['Size', formatBytes(manifest.bytes)],
    ['Schema', String(manifest.schemaVersion)],
    ['Encrypted', manifest.encrypted ? 'yes, it needs its recovery code' : 'no, anyone who has the file can read it'],
  ]
}

const STEPS = {
  check: 'Checking the backup and the recovery code…',
  close: 'Closing the store. This waits up to half a minute for agent sessions to let go of it…',
  swap: 'Putting the backup in place…',
  reopen: 'Opening the restored store…',
}

/**
 * What the page says while GET /restore/status reports a step.
 * @param {string | null} step
 */
export function stepText(step) {
  return (step !== null && STEPS[step]) || 'Restoring…'
}
