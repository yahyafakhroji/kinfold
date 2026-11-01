// The whole capture path for one event: edge redaction, then the spool write.
// Both the capture CLI (Claude Code) and the OpenCode plugin end here.

import type { NormalizedEvent } from '../contract/event'
import { writeSpoolEntry } from '../spool/spool'
import { type PrepareOptions, prepareForSpool } from './prepare'

export interface CaptureOptions extends PrepareOptions {
  spoolDir: string
}

/** Returns the spool file path. */
export function captureEvent(event: NormalizedEvent, options: CaptureOptions): string {
  return writeSpoolEntry(options.spoolDir, prepareForSpool(event, options))
}
