import { describe, expect, test } from 'bun:test'
import { declaredLength, readCapped, readCappedText } from './capped'

/** A body sent in `sizes` chunks with no Content-Length; counts how many chunks the reader pulled. */
function chunked(sizes: readonly number[]): { message: { headers: Headers; body: ReadableStream<Uint8Array> }; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = sizes[pulled]
      if (size === undefined) return controller.close()
      pulled += 1
      controller.enqueue(new Uint8Array(size).fill(97))
    },
    cancel() {
      cancelled = true
    },
  }, { highWaterMark: 0 })
  return { message: { headers: new Headers(), body }, pulled: () => pulled, cancelled: () => cancelled }
}

describe('readCapped', () => {
  test('a body within the limit is returned whole, across chunks', async () => {
    const { message } = chunked([3, 4, 3])
    const bytes = await readCapped(message, 10)
    expect(bytes).toHaveLength(10)
    expect(new TextDecoder().decode(bytes!)).toBe('aaaaaaaaaa')
  })

  test('a declared length over the limit is refused before a byte is read', async () => {
    const { message, pulled } = chunked([1])
    message.headers.set('content-length', '11')
    expect(await readCapped(message, 10)).toBeNull()
    expect(pulled()).toBe(0)
  })

  test('a body with no declared length is refused by count, and the rest is not read', async () => {
    const { message, pulled, cancelled } = chunked([6, 6, 6, 6])
    expect(await readCapped(message, 10)).toBeNull()
    expect(pulled()).toBe(2)
    expect(cancelled()).toBe(true)
  })

  test('a sender that declares less than it sends is still held to the limit', async () => {
    const { message } = chunked([8, 8])
    message.headers.set('content-length', '4')
    expect(await readCapped(message, 10)).toBeNull()
  })

  test('a Content-Length that is not a number does not skip the count', async () => {
    const { message } = chunked([8, 8])
    message.headers.set('content-length', 'lots')
    expect(declaredLength(message)).toBe(0)
    expect(await readCapped(message, 10)).toBeNull()
  })

  test('no body reads as empty, and a Request and a Response both fit', async () => {
    expect(await readCapped({ headers: new Headers(), body: null }, 10)).toEqual(new Uint8Array(0))
    expect(await readCappedText(new Request('http://127.0.0.1/', { method: 'POST', body: 'héllo' }), 10)).toBe('héllo')
    expect(await readCappedText(new Response('héllo'), 5)).toBeNull()
    expect(await readCappedText(new Response('héllo'), 6)).toBe('héllo')
  })

  test('a cancel that rejects does not turn the refusal into an error', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(20)),
      cancel: () => Promise.reject(new Error('already closed')),
    })
    expect(await readCapped({ headers: new Headers(), body }, 10)).toBeNull()
  })
})
