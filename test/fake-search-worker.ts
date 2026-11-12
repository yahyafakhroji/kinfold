// A stand-in for src/vectors/search-worker.ts in vector-worker.test.ts. The
// start message's dbPath picks the behaviour: 'fail-start', 'slow' (never
// answers a request), 'crash' (throws on a request), anything else echoes one
// hit whose id is the nearest query's k, or the first id of a distances query.

import type { WorkerReply, WorkerRequest, WorkerStart } from '../src/vectors/vector-worker-protocol'

declare const self: Worker

let mode = 'ok'

self.onmessage = (event: MessageEvent<WorkerStart | WorkerRequest>) => {
  const message = event.data
  if (message.kind === 'start') {
    mode = message.dbPath
    const reply: WorkerReply = mode === 'fail-start' ? { kind: 'started', ok: false, reason: 'cannot open the store' } : { kind: 'started', ok: true }
    postMessage(reply)
    return
  }
  if (mode === 'slow') return
  if (mode === 'crash') throw new Error('worker blew up')
  const id = message.op === 'nearest' ? message.query.k : (message.query.ids[0] ?? 0)
  const reply: WorkerReply = { kind: 'hits', id: message.id, hits: [{ id, distance: 0.25 }] }
  postMessage(reply)
}
