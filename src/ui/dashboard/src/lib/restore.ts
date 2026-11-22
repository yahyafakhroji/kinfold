// The restore as plain state: Restore is offered only once a backup was
// uploaded and its description shown, the reader ticked the confirmation, and
// (for an encrypted backup) typed its recovery code. The code is never kept in
// this state: it goes from the field into the one request body restoreBody()
// builds, and the field is cleared in the same step.

import { bytes, dateOnly } from './format'

/** How often the page asks how a restore is going; the daemon stays up long enough after a fatal one for several asks. */
export const STATUS_POLL_MS = 700

export interface Manifest {
  createdAt: number
  kinfoldVersion: string
  schemaVersion: number
  encrypted: boolean
  bytes: number
}

export type RestoreFlow = { stage: 'idle' } | { stage: 'uploaded'; upload: string; manifest: Manifest }

export function uploadedRestore(answer: unknown): RestoreFlow {
  const bad = new Error('Kinfold could not describe that file. Is it a Kinfold backup?')
  if (typeof answer !== 'object' || answer === null) throw bad
  const { upload, manifest } = answer as { upload?: unknown; manifest?: Partial<Manifest> | null }
  if (typeof upload !== 'string' || typeof manifest !== 'object' || manifest === null) throw bad
  const { createdAt, kinfoldVersion, schemaVersion, encrypted, bytes: size } = manifest
  if (typeof createdAt !== 'number' || typeof kinfoldVersion !== 'string' || typeof schemaVersion !== 'number' || typeof encrypted !== 'boolean' || typeof size !== 'number') throw bad
  return { stage: 'uploaded', upload, manifest: { createdAt, kinfoldVersion, schemaVersion, encrypted, bytes: size } }
}

export function canRestore(flow: RestoreFlow, code: string, confirmed: boolean): boolean {
  return flow.stage === 'uploaded' && confirmed && (!flow.manifest.encrypted || code.trim() !== '')
}

export function restoreBody(flow: RestoreFlow, code: string, confirmed: boolean): { upload: string; code?: string } {
  if (flow.stage !== 'uploaded' || !canRestore(flow, code, confirmed)) throw new Error('Choose a backup, type its recovery code and confirm first.')
  return flow.manifest.encrypted ? { upload: flow.upload, code: code.trim() } : { upload: flow.upload }
}

export function describeManifest(manifest: Manifest): [string, string][] {
  return [
    ['Made', dateOnly(manifest.createdAt)],
    ['Kinfold version', manifest.kinfoldVersion],
    ['Size', bytes(manifest.bytes)],
    ['Encrypted', manifest.encrypted ? 'Yes. It needs its recovery code.' : 'No. Anyone with the file can read it.'],
  ]
}

const STEPS: Readonly<Record<string, string>> = {
  check: 'Checking the backup and the recovery code…',
  close: 'Closing the memory store. This waits up to half a minute for agent sessions to let go of it…',
  swap: 'Putting the backup in place…',
  reopen: 'Opening the restored memory…',
}

const UNDO_STEPS: Readonly<Record<string, string>> = {
  check: 'Checking the kept memory and its key…',
  close: 'Closing the memory store. This waits up to half a minute for agent sessions to let go of it…',
  swap: 'Putting the kept memory back…',
  reopen: 'Opening the memory…',
}

export function stepText(step: string | null, undo = false): string {
  const steps = undo ? UNDO_STEPS : STEPS
  return (step !== null ? steps[step] : undefined) ?? (undo ? 'Switching back…' : 'Restoring…')
}
