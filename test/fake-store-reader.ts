// A stand-in for src/resources/workers/store-reader-worker.ts in store-reader.test.ts.
// The start message's dbPath picks the behaviour: 'fail-start', 'busy' (blocks
// its thread for 300 ms per request, then answers, skipping a request already
// past its expiry as the real worker does), 'crash' (throws on a request),
// anything else answers at once. Every op answers with its arguments.

import type { StoreReaderMessage, StoreReaderReply } from '../src/resources/workers/store-reader-protocol'

declare const self: Worker

const BUSY_MS = 300
let mode = 'ok'

function busy(): void {
  const until = Date.now() + BUSY_MS
  while (Date.now() < until) {
    // Spinning on purpose: a cold read holds the worker's thread like this.
  }
}

self.onmessage = (event: MessageEvent<StoreReaderMessage>) => {
  const message = event.data
  if (message.kind === 'start') {
    mode = message.dbPath
    const reply: StoreReaderReply = mode === 'fail-start' ? { kind: 'started', ok: false, reason: 'cannot open the store' } : { kind: 'started', ok: true }
    postMessage(reply)
    return
  }
  if (message.kind === 'close') {
    postMessage({ kind: 'closed' } satisfies StoreReaderReply)
    return
  }
  if (mode === 'crash') throw new Error('the fake reader crashed')
  if (Date.now() > message.expireAt) {
    postMessage({ kind: 'expired', id: message.id } satisfies StoreReaderReply)
    return
  }
  if (mode === 'busy') busy()
  postMessage({ kind: 'answer', id: message.id, value: message.args } satisfies StoreReaderReply)
}
