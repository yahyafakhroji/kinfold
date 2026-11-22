// The one size limit for a body this program reads off a socket: a request the
// daemon or the hub was sent, or an answer a client was given. No imports
// beyond the platform, so every layer can use it.

/** What a Request and a Response share. */
export interface Message {
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

/** The Content-Length the sender declared; 0 when it is missing or not a number. */
export function declaredLength(message: Pick<Message, 'headers'>): number {
  const length = Number(message.headers.get('content-length') ?? '0')
  return Number.isFinite(length) ? length : 0
}

/**
 * The body, or null when it is longer than `limit` bytes. A declared length
 * over the limit is refused before a byte is read; otherwise the body is read
 * a chunk at a time and dropped the moment the count passes the limit, so a
 * sender that declares nothing, or lies, still cannot make the reader hold
 * more than the cap. A message without a body reads as empty.
 */
export async function readCapped(message: Message, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (declaredLength(message) > limit) return null
  if (message.body === null) return new Uint8Array(0)
  const reader = message.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** The body as UTF-8 text, or null when it is longer than `limit` bytes. */
export async function readCappedText(message: Message, limit: number): Promise<string | null> {
  const bytes = await readCapped(message, limit)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}

/** The cap for an answer a client reads from the hub or the daemon: far above any real one (a dashboard view, an MCP read), so a bigger body is not from Kinfold. */
export const MAX_ANSWER_BYTES = 16 * 1024 * 1024

/** JSON from a body of at most `limit` bytes; null for a longer body or one that is not JSON. */
export async function readCappedJson(message: Message, limit: number): Promise<unknown> {
  const text = await readCappedText(message, limit)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
