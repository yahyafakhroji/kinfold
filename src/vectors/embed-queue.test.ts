import { expect, test } from 'bun:test'
import { createEmbedQueue } from './embed-queue'

function recordingInference(): { order: string[]; embed: (text: string) => Promise<Float32Array> } {
  const order: string[] = []
  return {
    order,
    embed: async (text) => {
      order.push(text)
      await Bun.sleep(1)
      return new Float32Array([text.length])
    },
  }
}

test('answers one vector per text, in order', async () => {
  const inference = recordingInference()
  const queue = createEmbedQueue(inference)
  const vectors = await queue.submit(['a', 'bb', 'ccc'], 'index')
  expect(vectors.map((v) => v[0])).toEqual([1, 2, 3])
})

test('a query runs before the rest of an indexing batch', async () => {
  const inference = recordingInference()
  const queue = createEmbedQueue(inference)
  const batch = queue.submit(['i1', 'i2', 'i3', 'i4'], 'index')
  await Bun.sleep(0)
  const query = queue.submit(['q'], 'query')
  await Promise.all([batch, query])
  expect(inference.order.indexOf('q')).toBeLessThan(inference.order.indexOf('i3'))
  expect(inference.order).toHaveLength(5)
})

test('a cancelled job stops and rejects', async () => {
  const inference = recordingInference()
  const queue = createEmbedQueue(inference)
  const job = queue.submit(['a', 'b', 'c', 'd'], 'index')
  queue.cancel(job.id)
  await expect(job).rejects.toThrow('cancelled')
  expect(inference.order.length).toBeLessThan(4)
})

test('a failing text rejects its job and the next job still runs', async () => {
  const queue = createEmbedQueue({
    embed: async (text) => {
      if (text === 'bad') throw new Error('boom')
      return new Float32Array([1])
    },
  })
  await expect(queue.submit(['bad'], 'index')).rejects.toThrow('boom')
  expect(await queue.submit(['good'], 'index')).toHaveLength(1)
})
