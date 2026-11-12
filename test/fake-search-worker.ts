// A stand-in for src/vectors/search-worker.ts in vector-worker.test.ts. The
// start message's dbPath picks the behaviour: 'fail-start', 'slow' (never
// answers a request), 'busy' (blocks its thread for 300 ms per request, then
// answers, dropping a request already past its deadline as the real worker
// does), 'crash' (throws on a request), anything else answers at once. A hit's
// id is the nearest query's k, or the first id of a distances query.

import type { WorkerClose, WorkerReply, WorkerRequest, WorkerStart } from '../src/vectors/vector-worker-protocol'

declare const self: Worker

const BUSY_MS = 300
let mode = 'ok'

self.onmessage = (event: MessageEvent<WorkerStart | WorkerRequest | WorkerClose>) => {
  const message = event.data
  if (message.kind === 'start') {
    mode = message.dbPath
    const reply: WorkerReply = mode === 'fail-start' ? { kind: 'started', ok: false, reason: 'cannot open the store' } : { kind: 'started', ok: true }
    postMessage(reply)
    return
  }
  if (message.kind === 'close') {
    postMessage({ kind: 'closed' } satisfies WorkerReply)
    return
  }
  if (mode === 'slow') return
  if (mode === 'crash') throw new Error('worker blew up')
  if (mode === 'busy') {
    if (Date.now() > message.deadlineAt) {
      postMessage({ kind: 'expired', id: message.id } satisfies WorkerReply)
      return
    }
    const until = Date.now() + BUSY_MS
    while (Date.now() < until) {
      // A cold scan holds the worker's thread like this.
    }
  }
  const id = message.op === 'nearest' ? message.query.k : (message.query.ids[0] ?? 0)
  postMessage({ kind: 'hits', id: message.id, hits: [{ id, distance: 0.25 }] } satisfies WorkerReply)
}
