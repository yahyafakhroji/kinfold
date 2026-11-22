import { expect, test } from 'bun:test'
import { readBodyCapped } from './capped-body'

/** A body that never ends, in 64 KB pieces, counting how many were asked for. */
export function endless(): { response: Response; pulls: () => number } {
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      controller.enqueue(new Uint8Array(64 * 1024))
    },
  }, { highWaterMark: 0 })
  return { response: new Response(body), pulls: () => pulls }
}

test('a body within the cap comes back whole', async () => {
  expect(await readBodyCapped(new Response('hello'), 5)).toEqual(new TextEncoder().encode('hello'))
  expect(await readBodyCapped(new Response(null), 5)).toEqual(new Uint8Array(0))
})

test('a body that declares more than the cap is refused before any of it is read', async () => {
  const { response, pulls } = endless()
  response.headers.set('content-length', '1000001')
  expect(await readBodyCapped(response, 1_000_000)).toBeNull()
  expect(pulls()).toBe(0)
})

test('a body that only turns out larger is dropped as soon as it passes the cap, not buffered to its end', async () => {
  const { response, pulls } = endless()
  expect(await readBodyCapped(response, 200_000)).toBeNull()
  expect(pulls()).toBeLessThanOrEqual(5)
})
