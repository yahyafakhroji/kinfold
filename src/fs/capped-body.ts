// Reads a download with a ceiling. A size check after `arrayBuffer()` comes
// too late: by then a body of any size is already in memory. Here a declared
// length past the cap is refused unread, and a body that only turns out too
// large is dropped as soon as it passes the cap.

/** The whole body, or null when it is larger than `maxBytes`; the rest of the stream is cancelled then. */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const body = response.body
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await body?.cancel().catch(() => {})
    return null
  }
  if (body === null) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}
