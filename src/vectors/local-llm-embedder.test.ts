import { describe, expect, test } from 'bun:test'
import { EmbedError } from './embedder'
import { createLocalLlmEmbedder, probeLocalLlmDims } from './local-llm-embedder'

interface Seen {
  url: string
  init: RequestInit
}

function answering(body: unknown, status = 200): { seen: Seen[]; fetch: (url: string, init: RequestInit) => Promise<Response> } {
  const seen: Seen[] = []
  return {
    seen,
    fetch: async (url, init) => {
      seen.push({ url, init })
      return new Response(JSON.stringify(body), { status })
    },
  }
}

const vectors = (count: number, dims: number) => ({ data: Array.from({ length: count }, (_, index) => ({ index, embedding: Array.from({ length: dims }, () => 0.5) })) })

describe('createLocalLlmEmbedder', () => {
  test('posts the model and texts to the endpoint and names its space', async () => {
    const server = answering(vectors(2, 3))
    const embedder = createLocalLlmEmbedder({ url: 'http://127.0.0.1:11434/v1', model: 'nomic', dims: 3, fetch: server.fetch })
    expect(embedder.model).toBe('local-llm/nomic')
    expect((await embedder.embed(['a', 'b'])).map((v) => v.length)).toEqual([3, 3])
    expect(server.seen[0]!.url).toBe('http://127.0.0.1:11434/v1/embeddings')
    expect(JSON.parse(server.seen[0]!.init.body as string)).toEqual({ model: 'nomic', input: ['a', 'b'], encoding_format: 'float' })
    // A redirect could carry the text off this machine.
    expect(server.seen[0]!.init.redirect).toBe('error')
  })

  test('refuses an address off this machine before any request', () => {
    expect(() => createLocalLlmEmbedder({ url: 'http://10.1.1.1:11434', model: 'm', dims: 3, fetch: answering({}).fetch })).toThrow('loopback')
  })

  test('a server error is an http_error with the status only', async () => {
    const embedder = createLocalLlmEmbedder({ url: 'http://127.0.0.1:1', model: 'm', dims: 3, fetch: answering({ error: 'secret echo' }, 500).fetch })
    const error = (await embedder.embed(['a']).catch((caught: unknown) => caught)) as EmbedError
    expect(error.kind).toBe('http_error')
    expect(error.message).toBe('the local LLM answered 500')
  })

  test('a vector of the wrong length is a bad_response', async () => {
    const embedder = createLocalLlmEmbedder({ url: 'http://127.0.0.1:1', model: 'm', dims: 4, fetch: answering(vectors(1, 3)).fetch })
    expect(((await embedder.embed(['a']).catch((caught: unknown) => caught)) as EmbedError).kind).toBe('bad_response')
  })
})

describe('probeLocalLlmDims', () => {
  test('learns the length from one embedding', async () => {
    expect(await probeLocalLlmDims({ url: 'http://127.0.0.1:1', model: 'm', fetch: answering(vectors(1, 768)).fetch })).toEqual({ ok: true, dims: 768 })
  })

  test('names a server that is not there', async () => {
    const answer = await probeLocalLlmDims({ url: 'http://127.0.0.1:1', model: 'm', fetch: async () => Promise.reject(new TypeError('connect refused')) })
    expect(answer).toEqual({ ok: false, reason: 'the local LLM did not answer at http://127.0.0.1:1 (TypeError)' })
  })
})
