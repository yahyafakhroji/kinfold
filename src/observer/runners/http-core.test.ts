import { expect, test } from 'bun:test'
import { ObserverError } from '../types'
import { postJson } from './http-core'

test('a redirect is refused: the session text and the key are never sent on to where an endpoint points', async () => {
  const received: { path: string; authorization: string | null; body: string }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      received.push({ path, authorization: request.headers.get('authorization'), body: await request.text() })
      if (path === '/v1/chat') return new Response(null, { status: 307, headers: { location: '/elsewhere' } })
      return Response.json({ taken: true })
    },
  })
  try {
    const post = postJson({ fetch: (url, init) => fetch(url, init), url: `http://127.0.0.1:${server.port}/v1/chat`, headers: { authorization: 'Bearer test-key' }, body: { text: 'session text' }, timeoutMs: 5_000, label: 'test' })
    await expect(post).rejects.toBeInstanceOf(ObserverError)
    expect(received.map((request) => request.path)).toEqual(['/v1/chat'])
  } finally {
    await server.stop(true)
  }
})
