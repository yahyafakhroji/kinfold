// Reads a download with a ceiling. A size check after `arrayBuffer()` comes
// too late: by then a body of any size is already in memory. Here a declared
// length past the cap is refused unread, and a body that only turns out too
// large is dropped as soon as it passes the cap.

import { readCapped } from '../http/capped'

/** The whole body, or null when it is larger than `maxBytes`; the rest of the stream is cancelled then. The count is the one every capped read shares (http/capped.ts). */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const bytes = await readCapped(response, maxBytes)
  // Refused on its declared length, the body was never opened: a download is let go, not left to arrive unread.
  if (bytes === null) await response.body?.cancel().catch(() => {})
  return bytes
}
